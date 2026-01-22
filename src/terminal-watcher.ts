/**
 * Terminal session watcher for syncing terminal activity to Slack.
 * Polls session JSONL files and posts new messages to Slack channels.
 */

import { WebClient } from '@slack/web-api';
import { Session, getSession, getThreadSession, saveMessageMapping } from './session-manager.js';
import {
  getSessionFilePath,
  getFileSize,
  extractTextContent,
  sessionFileExists,
  SessionFileMessage,
} from './session-reader.js';
import { markdownToSlack, stripMarkdownCodeFence } from './utils.js';
import { withSlackRetry } from './retry.js';
import { truncateWithClosedFormatting, uploadMarkdownAndPngWithResponse } from './streaming.js';
import { syncMessagesFromOffset, MessageSyncState } from './message-sync.js';
import { buildStopWatchingButton } from './blocks.js';

/**
 * State for an active terminal watcher.
 * Exported for /ff (fast-forward) command to construct state for posting missed messages.
 */
export interface WatchState {
  conversationKey: string;  // channelId or channelId_threadTs
  channelId: string;
  threadTs?: string;
  sessionId: string;
  workingDir: string;
  fileOffset: number;
  intervalId: NodeJS.Timeout;
  statusMsgTs: string;
  client: WebClient;  // Store client reference for rate updates
  updateRateMs: number;
  userId?: string;  // User who initiated /continue (for ephemeral errors)
  pollInProgress?: boolean;  // Prevents overlapping polls
  // Activity message tracking per turn (keyed by userInput UUID)
  // Stores Slack ts for each turn's activity message, enabling update-in-place
  activityMessages: Map<string, string>;
}

/**
 * Active watchers by conversationKey (channelId or channelId_threadTs).
 */
const activeWatchers = new Map<string, WatchState>();

/**
 * Get conversation key for watcher map.
 */
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

/**
 * Check if a conversation is being watched.
 */
export function isWatching(channelId: string, threadTs?: string): boolean {
  return activeWatchers.has(getConversationKey(channelId, threadTs));
}

/**
 * Start watching a terminal session.
 */
export function startWatching(
  channelId: string,
  threadTs: string | undefined,
  session: Session,
  client: WebClient,
  statusMsgTs: string,
  userId?: string  // For ephemeral error notifications
): { success: boolean; error?: string } {
  const conversationKey = getConversationKey(channelId, threadTs);

  // Stop existing watcher if any
  if (activeWatchers.has(conversationKey)) {
    stopWatching(channelId, threadTs);
  }

  // Validate session
  if (!session.sessionId) {
    return { success: false, error: 'No active session' };
  }

  // Check if session file exists
  if (!sessionFileExists(session.sessionId, session.workingDir)) {
    return { success: false, error: 'Session file not found. Start a conversation in terminal first.' };
  }

  const filePath = getSessionFilePath(session.sessionId, session.workingDir);
  const updateRateMs = (session.updateRateSeconds ?? 2) * 1000;
  const initialOffset = getFileSize(filePath);

  const state: WatchState = {
    conversationKey,
    channelId,
    threadTs,
    sessionId: session.sessionId,
    workingDir: session.workingDir,
    fileOffset: initialOffset,
    intervalId: null as any,
    statusMsgTs,
    client,
    updateRateMs,
    userId,
    activityMessages: new Map(),
  };

  // Start polling - poll immediately, then on interval
  pollForChanges(state);
  state.intervalId = setInterval(async () => {
    await pollForChanges(state);
  }, updateRateMs);

  activeWatchers.set(conversationKey, state);
  console.log(`[TerminalWatcher] Started watching ${conversationKey}, session=${session.sessionId}, offset=${initialOffset}`);

  return { success: true };
}

/**
 * Stop watching a terminal session.
 */
export function stopWatching(channelId: string, threadTs?: string): boolean {
  const conversationKey = getConversationKey(channelId, threadTs);
  const state = activeWatchers.get(conversationKey);

  if (!state) return false;

  clearInterval(state.intervalId);
  activeWatchers.delete(conversationKey);
  console.log(`[TerminalWatcher] Stopped watching ${conversationKey}`);

  return true;
}

/**
 * Stop all watchers (for graceful shutdown).
 */
export function stopAllWatchers(): void {
  for (const [key, state] of activeWatchers) {
    clearInterval(state.intervalId);
    console.log(`[TerminalWatcher] Stopped watcher ${key} (shutdown)`);
  }
  activeWatchers.clear();
}

/**
 * Update poll rate for active watcher (when /update-rate is called).
 */
export function updateWatchRate(channelId: string, threadTs: string | undefined, newRateSeconds: number): boolean {
  const conversationKey = getConversationKey(channelId, threadTs);
  const state = activeWatchers.get(conversationKey);

  if (!state) return false;

  // Clear old interval and create new one with updated rate
  clearInterval(state.intervalId);
  state.updateRateMs = newRateSeconds * 1000;
  state.intervalId = setInterval(async () => {
    await pollForChanges(state);
  }, state.updateRateMs);

  console.log(`[TerminalWatcher] Updated rate for ${conversationKey} to ${newRateSeconds}s`);
  return true;
}

/**
 * Get watcher for a conversation (for cleanup operations).
 * NOTE: Must be exported - used by slack-bot.ts for auto-stop message updates
 */
export function getWatcher(channelId: string, threadTs?: string): WatchState | undefined {
  return activeWatchers.get(getConversationKey(channelId, threadTs));
}

/**
 * Cleanup watcher when session is cleared.
 */
export function onSessionCleared(channelId: string, threadTs?: string): void {
  if (isWatching(channelId, threadTs)) {
    const state = getWatcher(channelId, threadTs);
    if (state) {
      notifyWatcherStopped(state, 'Stopped watching (session cleared)');
    }
    stopWatching(channelId, threadTs);
  }
}

/**
 * Poll for new messages in the session file.
 *
 * Uses shared syncMessagesFromOffset() function to post messages.
 * Only advances file offset after ALL messages are successfully posted.
 */
async function pollForChanges(state: WatchState): Promise<void> {
  // Prevent overlapping polls (if previous poll is still in progress)
  if (state.pollInProgress) {
    console.log(`[TerminalWatcher] Skipping poll for ${state.conversationKey} - previous poll still in progress`);
    return;
  }
  state.pollInProgress = true;

  try {
    const filePath = getSessionFilePath(state.sessionId, state.workingDir);
    console.log(`[TerminalWatcher] Polling ${state.conversationKey} at offset ${state.fileOffset}`);

    // Create sync state from watch state
    const syncState: MessageSyncState = {
      conversationKey: state.conversationKey,
      channelId: state.channelId,
      threadTs: state.threadTs,
      sessionId: state.sessionId,
      workingDir: state.workingDir,
      client: state.client,
    };

    const syncResult = await syncMessagesFromOffset(syncState, filePath, state.fileOffset, {
      infiniteRetry: false,  // /watch uses limited retries
      postTextMessage: (s, msg, isLastMessage) => postTerminalMessage(state, msg, isLastMessage),
      activityMessages: state.activityMessages,  // Pass activity ts map for update-in-place
    });

    console.log(`[TerminalWatcher] Poll result: synced=${syncResult.syncedCount}/${syncResult.totalToSync}`);

    // Note: We don't update fileOffset - messageMap handles deduplication
    // This simplifies logic and avoids offset advancement bugs

    // Move status message to bottom after posting new messages
    if (syncResult.syncedCount > 0) {
      await moveStatusMessageToBottom(state);
    }
  } catch (error) {
    console.error(`[TerminalWatcher] Poll error for ${state.conversationKey}:`, error);
    // Don't stop on transient errors - will retry next poll
  } finally {
    state.pollInProgress = false;
  }
}

/**
 * Build blocks for the status message with Stop Watching button.
 */
function buildStatusBlocks(state: WatchState): any[] {
  const updateRateSeconds = state.updateRateMs / 1000;
  return [
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `:eye: Watching for terminal activity... Updates every ${updateRateSeconds}s`,
      }],
    },
    buildStopWatchingButton(state.sessionId),
  ];
}

/**
 * Move status message to bottom by deleting old and posting new.
 */
async function moveStatusMessageToBottom(state: WatchState): Promise<void> {
  try {
    // Delete old status message
    await state.client.chat.delete({
      channel: state.channelId,
      ts: state.statusMsgTs,
    });
  } catch (error) {
    // Ignore delete errors (message may already be deleted)
    console.log(`[TerminalWatcher] Could not delete old status message: ${error}`);
  }

  try {
    // Post new status message at bottom
    const result = await withSlackRetry(() =>
      state.client.chat.postMessage({
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: 'Watching terminal...',
        blocks: buildStatusBlocks(state),
      })
    );

    // Update state with new message ts
    if (result?.ts) {
      state.statusMsgTs = result.ts as string;
    }
  } catch (error) {
    console.error(`[TerminalWatcher] Failed to post new status message:`, error);
  }
}

/**
 * Post a terminal message with TEXT content to Slack.
 * - Uses session config for message size (threadCharLimit)
 * - Smart truncation with closed formatting (code blocks, bold, italic)
 * - File attachments (.md + .png) for assistant output
 * - Message mapping for thread forking
 *
 * NOTE: This function only handles messages with text content.
 * Activity-only messages (thinking/tools but no text output) are handled by
 * syncMessagesFromOffset() in message-sync.ts.
 *
 * Exported for use as callback in syncMessagesFromOffset().
 *
 * @returns true if message was successfully posted (and saved to messageMap), false on failure
 */
export async function postTerminalMessage(state: WatchState, msg: SessionFileMessage, isFinalSegment?: boolean): Promise<boolean> {
  const rawText = extractTextContent(msg);

  // Get session config - use correct function for channel vs thread
  const session = state.threadTs
    ? getThreadSession(state.channelId, state.threadTs)
    : getSession(state.channelId);
  const charLimit = session?.threadCharLimit ?? 500;

  // If no text content, nothing to post - activity-only messages are handled by message-sync.ts
  if (!rawText.trim()) {
    return true;
  }

  if (msg.type === 'user') {
    // User input: simple text post (no file attachments)
    let slackText = markdownToSlack(rawText);
    if (slackText.length > charLimit) {
      slackText = truncateWithClosedFormatting(slackText, charLimit);
    }
    const fullText = ':inbox_tray: *Terminal Input*\n' + slackText;

    try {
      const result = await withSlackRetry(() =>
        state.client.chat.postMessage({
          channel: state.channelId,
          thread_ts: state.threadTs,
          text: fullText,
        })
      );

      // Save mapping for thread forking
      if (result?.ts) {
        await saveMessageMapping(state.channelId, result.ts, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'user',
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error(`[TerminalWatcher] Failed to post user message:`, error);
      return false;
    }
  } else {
    // Check if content is tool-only (no actual text output)
    // Matches: [Tool: Read], [Tool: Write]\n[Tool: Bash], etc.
    const isToolOnly = /^(\[Tool: [^\]]+\]\n?)+$/.test(rawText.trim());

    if (isToolOnly) {
      // Tool-only messages: simple text post (no file attachments)
      let slackText = rawText;
      if (slackText.length > charLimit) {
        slackText = truncateWithClosedFormatting(slackText, charLimit);
      }
      const fullText = ':outbox_tray: *Terminal Output*\n' + slackText;

      try {
        const result = await withSlackRetry(() =>
          state.client.chat.postMessage({
            channel: state.channelId,
            thread_ts: state.threadTs,
            text: fullText,
          })
        );

        if (result?.ts) {
          await saveMessageMapping(state.channelId, result.ts, {
            sdkMessageId: msg.uuid,
            sessionId: state.sessionId,
            type: 'assistant',
          });
          return true;
        }
        return false;
      } catch (error) {
        console.error(`[TerminalWatcher] Failed to post tool-only message:`, error);
        return false;
      }
    }

    // Assistant output with real content: full bot fidelity with .md + .png
    const strippedMarkdown = stripMarkdownCodeFence(rawText, {
      stripEmptyTag: session?.stripEmptyTag
    });
    const slackText = markdownToSlack(strippedMarkdown);
    const prefix = ':outbox_tray: *Terminal Output*\n';

    try {
      const uploaded = await uploadMarkdownAndPngWithResponse(
        state.client,
        state.channelId,
        strippedMarkdown,
        prefix + slackText,
        state.threadTs,
        state.userId,  // For ephemeral error notifications (may be undefined)
        charLimit,
        session?.stripEmptyTag
        // Note: Fork button now on activity message, not response
      );

      // Save mapping for thread forking
      if (uploaded?.ts) {
        await saveMessageMapping(state.channelId, uploaded.ts, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'assistant',
        });
        return true;
      }

      // Upload succeeded but ts extraction failed - don't post duplicate fallback
      // Save mapping with synthetic ts to prevent re-processing on subsequent polls
      if ((uploaded as any)?.uploadSucceeded) {
        console.warn('[TerminalWatcher] Upload succeeded but ts unavailable, using synthetic ts for deduplication');
        const syntheticTs = `uploaded-no-ts-${msg.uuid}`;
        await saveMessageMapping(state.channelId, syntheticTs, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'assistant',
        });
        return true;
      }

      // Fallback if upload fails (returns null)
      let fallbackText = slackText;
      if (fallbackText.length > charLimit) {
        fallbackText = truncateWithClosedFormatting(fallbackText, charLimit);
      }
      const fallbackResult = await withSlackRetry(() =>
        state.client.chat.postMessage({
          channel: state.channelId,
          thread_ts: state.threadTs,
          text: prefix + fallbackText,
        })
      );

      // Still save mapping even for fallback
      if (fallbackResult?.ts) {
        await saveMessageMapping(state.channelId, fallbackResult.ts, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'assistant',
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error(`[TerminalWatcher] Failed to post assistant message:`, error);
      return false;
    }
  }
}

/**
 * Notify user that watcher stopped.
 */
async function notifyWatcherStopped(state: WatchState, reason: string): Promise<void> {
  try {
    await state.client.chat.update({
      channel: state.channelId,
      ts: state.statusMsgTs,
      text: reason,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `:white_check_mark: ${reason}` },
      }],
    });
  } catch (error) {
    console.error(`[TerminalWatcher] Failed to update stop message:`, error);
  }
}

