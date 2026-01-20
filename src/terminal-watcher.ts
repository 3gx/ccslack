/**
 * Terminal session watcher for syncing terminal activity to Slack.
 * Polls session JSONL files and posts new messages to Slack channels.
 */

import { WebClient } from '@slack/web-api';
import { Session, getSession, getThreadSession, saveMessageMapping } from './session-manager.js';
import {
  getSessionFilePath,
  getFileSize,
  readNewMessages,
  extractTextContent,
  sessionFileExists,
  SessionFileMessage
} from './session-reader.js';
import { markdownToSlack, stripMarkdownCodeFence } from './utils.js';
import { withSlackRetry } from './retry.js';
import { truncateWithClosedFormatting, uploadMarkdownAndPngWithResponse } from './streaming.js';

/**
 * State for an active terminal watcher.
 */
interface WatchState {
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
 */
async function pollForChanges(state: WatchState): Promise<void> {
  try {
    const filePath = getSessionFilePath(state.sessionId, state.workingDir);
    const { messages, newOffset } = await readNewMessages(filePath, state.fileOffset);

    if (messages.length === 0) {
      return;
    }

    state.fileOffset = newOffset;

    // Post each message
    for (const msg of messages) {
      await postTerminalMessage(state, msg);
    }

    // Move status message to bottom after posting new messages
    await moveStatusMessageToBottom(state);
  } catch (error) {
    console.error(`[TerminalWatcher] Poll error for ${state.conversationKey}:`, error);
    // Don't stop on transient errors - will retry next poll
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
    {
      type: 'actions',
      block_id: `terminal_watch_${state.sessionId}`,
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Stop Watching' },
        action_id: 'stop_terminal_watch',
        value: JSON.stringify({ sessionId: state.sessionId }),
      }],
    },
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
 * Post a terminal message to Slack with full bot fidelity.
 * - Uses session config for message size (threadCharLimit)
 * - Smart truncation with closed formatting (code blocks, bold, italic)
 * - File attachments (.md + .png) for assistant output
 * - Message mapping for thread forking
 */
async function postTerminalMessage(state: WatchState, msg: SessionFileMessage): Promise<void> {
  const rawText = extractTextContent(msg);
  if (!rawText.trim()) return;

  // Get session config - use correct function for channel vs thread
  const session = state.threadTs
    ? getThreadSession(state.channelId, state.threadTs)
    : getSession(state.channelId);
  const charLimit = session?.threadCharLimit ?? 500;

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
        saveMessageMapping(state.channelId, result.ts, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'user',
        });
      }
    } catch (error) {
      console.error(`[TerminalWatcher] Failed to post user message:`, error);
    }
  } else {
    // Assistant output: full bot fidelity with .md + .png
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
        session?.stripEmptyTag,
        // Add "Fork here" button for thread messages (creates independent fork, safe during watch)
        state.threadTs ? { threadTs: state.threadTs, conversationKey: state.conversationKey } : undefined
      );

      // Save mapping for thread forking
      if (uploaded?.ts) {
        saveMessageMapping(state.channelId, uploaded.ts, {
          sdkMessageId: msg.uuid,
          sessionId: state.sessionId,
          type: 'assistant',
        });
      }

      // Fallback if upload fails
      if (!uploaded) {
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
          saveMessageMapping(state.channelId, fallbackResult.ts, {
            sdkMessageId: msg.uuid,
            sessionId: state.sessionId,
            type: 'assistant',
          });
        }
      }
    } catch (error) {
      console.error(`[TerminalWatcher] Failed to post assistant message:`, error);
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
