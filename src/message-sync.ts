/**
 * Message sync module - single source of truth for syncing terminal messages to Slack.
 * Used by both /ff (fast-forward) and /watch commands.
 */

import { WebClient } from '@slack/web-api';
import {
  readNewMessages,
  SessionFileMessage,
  buildActivityEntriesFromMessage,
  extractTextContent,
  ImportedActivityEntry,
} from './session-reader.js';
import {
  getMessageMapUuids,
  saveMessageMapping,
  saveActivityLog,
  ActivityEntry,
} from './session-manager.js';
import { withSlackRetry, withInfiniteRetry, sleep } from './retry.js';

/**
 * State required for posting messages to Slack.
 * Compatible with WatchState from terminal-watcher.ts.
 */
export interface MessageSyncState {
  conversationKey: string;
  channelId: string;
  threadTs?: string;
  sessionId: string;
  workingDir: string;
  client: WebClient;
}

/**
 * Options for sync behavior.
 */
export interface SyncOptions {
  /** Use infinite retries (/ff=true, /watch=false) */
  infiniteRetry?: boolean;
  /** Check if sync should abort (for /ff stop button) */
  isAborted?: () => boolean;
  /** Progress callback for UI updates */
  onProgress?: (synced: number, total: number, msg: SessionFileMessage) => Promise<void>;
  /** Delay between messages in ms (for /ff pacing) */
  pacingDelayMs?: number;
  /** Post function for text messages (allows /watch to use its own postTerminalMessage) */
  postTextMessage?: (state: MessageSyncState, msg: SessionFileMessage) => Promise<boolean>;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** New file offset after reading */
  newOffset: number;
  /** Number of messages successfully synced */
  syncedCount: number;
  /** Total messages that needed syncing */
  totalToSync: number;
  /** Whether sync was aborted by user */
  wasAborted: boolean;
  /** Whether all messages succeeded (for /watch offset advancement) */
  allSucceeded: boolean;
}

/**
 * Sync messages from a session file to Slack, starting at the given offset.
 * This is the core function used by both /ff and /watch.
 *
 * @param state - Slack posting state (channel, client, etc.)
 * @param filePath - Path to session JSONL file
 * @param fromOffset - Byte offset to start reading from
 * @param options - Sync behavior options
 * @returns Sync result with counts and new offset
 */
export async function syncMessagesFromOffset(
  state: MessageSyncState,
  filePath: string,
  fromOffset: number,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const {
    infiniteRetry = false,
    isAborted,
    onProgress,
    pacingDelayMs = 0,
    postTextMessage,
  } = options;

  // 1. Read messages from file
  const { messages, newOffset } = await readNewMessages(filePath, fromOffset);
  console.log(`[MessageSync] Read ${messages.length} messages from offset ${fromOffset}, new offset ${newOffset}`);
  if (messages.length === 0) {
    return {
      newOffset,
      syncedCount: 0,
      totalToSync: 0,
      wasAborted: false,
      allSucceeded: true,
    };
  }

  // 2. Filter by messageMap (skip already-posted messages)
  const alreadyPosted = getMessageMapUuids(state.channelId);
  const messagesToSync = messages.filter(m => !alreadyPosted.has(m.uuid));
  console.log(`[MessageSync] Filtered to ${messagesToSync.length} messages (${alreadyPosted.size} already posted)`);
  if (messagesToSync.length === 0) {
    return {
      newOffset,
      syncedCount: 0,
      totalToSync: 0,
      wasAborted: false,
      allSucceeded: true,
    };
  }

  // 3. Post each message
  let syncedCount = 0;
  let wasAborted = false;
  let allSucceeded = true;

  for (let i = 0; i < messagesToSync.length; i++) {
    // Check abort flag
    if (isAborted?.()) {
      wasAborted = true;
      console.log(`[MessageSync] Sync aborted at message ${i + 1}/${messagesToSync.length}`);
      break;
    }

    const msg = messagesToSync[i];

    // Double-check messageMap before posting to prevent race condition
    // (another sync operation might have posted this message while we were processing)
    const currentlyPosted = getMessageMapUuids(state.channelId);
    if (currentlyPosted.has(msg.uuid)) {
      console.log(`[MessageSync] Skipping ${msg.uuid} - already posted by concurrent operation`);
      syncedCount++; // Count as success since it's already posted
      continue;
    }

    const success = await postSingleMessage(state, msg, infiniteRetry, postTextMessage);

    if (success) {
      syncedCount++;
    } else {
      allSucceeded = false;
      // Continue trying other messages for /watch, but track failure
    }

    // Progress callback
    if (onProgress) {
      await onProgress(syncedCount, messagesToSync.length, msg);
    }

    // Pacing delay between messages (skip on last)
    if (pacingDelayMs > 0 && i < messagesToSync.length - 1) {
      await sleep(pacingDelayMs);
    }
  }

  return {
    newOffset,
    syncedCount,
    totalToSync: messagesToSync.length,
    wasAborted,
    allSucceeded,
  };
}

/**
 * Post a single message to Slack.
 * Handles both text messages and activity-only messages.
 *
 * @param state - Slack posting state
 * @param msg - Session file message to post
 * @param infiniteRetry - Whether to retry forever (true for /ff)
 * @param postTextMessage - Optional custom text message poster (for /watch)
 * @returns true if posted successfully
 */
async function postSingleMessage(
  state: MessageSyncState,
  msg: SessionFileMessage,
  infiniteRetry: boolean,
  postTextMessage?: (state: MessageSyncState, msg: SessionFileMessage) => Promise<boolean>
): Promise<boolean> {
  const textContent = extractTextContent(msg);
  const activityEntries = buildActivityEntriesFromMessage(msg);
  const hasText = textContent.trim().length > 0;

  console.log(`[MessageSync] Processing ${msg.uuid} (${msg.type}): hasText=${hasText}, activityEntries=${activityEntries.length}`);

  if (hasText) {
    // Text message - use provided poster or skip if none
    if (!postTextMessage) {
      console.error(`[MessageSync] No postTextMessage function provided for text message ${msg.uuid}`);
      return false;
    }

    if (infiniteRetry) {
      return await withInfiniteRetry(
        () => postTextMessage(state, msg),
        {
          baseDelayMs: 3000,
          maxDelayMs: 30000,
          onRetry: (error, attempt, delayMs) => {
            console.log(`[MessageSync] Message ${msg.uuid} failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
          },
          onSuccess: (attempts) => {
            if (attempts > 1) {
              console.log(`[MessageSync] Message ${msg.uuid} succeeded after ${attempts} attempts`);
            }
          },
        }
      );
    } else {
      return await postTextMessage(state, msg);
    }
  } else if (activityEntries.length > 0) {
    // Activity-only message - post summary with View Log button
    if (infiniteRetry) {
      return await withInfiniteRetry(
        () => postActivityOnlyMessage(state, msg, activityEntries),
        {
          baseDelayMs: 3000,
          maxDelayMs: 30000,
          onRetry: (error, attempt, delayMs) => {
            console.log(`[MessageSync] Activity ${msg.uuid} failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
          },
        }
      );
    } else {
      return await postActivityOnlyMessage(state, msg, activityEntries);
    }
  }

  // No text and no activity - nothing to post, but still record in messageMap
  // to prevent re-processing on next poll (offset doesn't advance by design)
  saveMessageMapping(state.channelId, `empty_${msg.uuid}`, {
    sdkMessageId: msg.uuid,
    sessionId: state.sessionId,
    type: msg.type as 'user' | 'assistant',
  });
  console.log(`[MessageSync] Recorded empty message ${msg.uuid} (no text, no activity)`);
  return true;
}

/**
 * Post an activity-only message (thinking/tools but no text output).
 * Creates a summary with View Log button for detailed inspection.
 *
 * @param state - Slack posting state
 * @param msg - Session file message
 * @param activityEntries - Parsed activity entries
 * @returns true if posted successfully
 */
async function postActivityOnlyMessage(
  state: MessageSyncState,
  msg: SessionFileMessage,
  activityEntries: ImportedActivityEntry[]
): Promise<boolean> {
  const thinkingCount = activityEntries.filter(e => e.type === 'thinking').length;
  const toolCount = activityEntries.filter(e => e.type === 'tool_start').length;

  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) {
    const toolNames = activityEntries
      .filter(e => e.type === 'tool_start')
      .map(e => e.tool)
      .join(', ');
    parts.push(`tools: ${toolNames}`);
  }

  const summaryText = `:brain: *Terminal Activity* (${parts.join(', ')})`;

  // Use a unique key for this message's activity (for the View Log button)
  const activityKey = `${state.conversationKey}_sync_${msg.uuid}`;

  try {
    const result = await withSlackRetry(() =>
      state.client.chat.postMessage({
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: summaryText,
        blocks: [
          {
            type: 'section' as const,
            text: { type: 'mrkdwn' as const, text: summaryText },
          },
          {
            type: 'actions' as const,
            block_id: `sync_activity_${msg.uuid}`,
            elements: [{
              type: 'button' as const,
              text: { type: 'plain_text' as const, text: 'View Log' },
              action_id: `view_activity_log_${activityKey}`,
              value: activityKey,
            }],
          },
        ],
      })
    ) as { ts?: string };

    // Save activity entries for View Log modal
    // Cast to ActivityEntry[] since ImportedActivityEntry is compatible
    await saveActivityLog(activityKey, activityEntries as unknown as ActivityEntry[]);

    // Save mapping for thread forking
    if (result?.ts) {
      saveMessageMapping(state.channelId, result.ts, {
        sdkMessageId: msg.uuid,
        sessionId: state.sessionId,
        type: msg.type as 'user' | 'assistant',
      });
      console.log(`[MessageSync] Posted activity summary for ${msg.uuid}: ${parts.join(', ')}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`[MessageSync] Failed to post activity summary:`, error);
    return false;
  }
}
