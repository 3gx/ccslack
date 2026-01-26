import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { Mutex } from 'async-mutex';
import { startClaudeQuery, ClaudeQuery, PermissionResult } from './claude-client.js';
import {
  getSession,
  saveSession,
  getOrCreateThreadSession,
  getThreadSession,
  saveThreadSession,
  deleteSession,
  saveMessageMapping,
  findForkPointMessageId,
  clearSyncedMessageUuids,
  addSlackOriginatedUserUuid,
  Session,
  ThreadSession,
  PermissionMode,
  ActivityEntry,
  ForkPointResult,
  LastUsage,
} from './session-manager.js';
import { isSessionActiveInTerminal, buildConcurrentWarningBlocks, getContinueCommand } from './concurrent-check.js';
import {
  buildStatusBlocks,
  buildHeaderBlocks,
  buildPlanApprovalBlocks,
  buildToolApprovalBlocks,
  buildForkAnchorBlocks,
  buildPathSetupBlocks,
  buildStatusPanelBlocks,
  buildActivityLogText,
  buildCombinedStatusBlocks,
  buildLiveActivityBlocks,
  ACTIVITY_LOG_MAX_CHARS,
  formatToolName,
  getToolEmoji,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
  buildStatusDisplayBlocks,
  buildSdkQuestionBlocks,
  buildAnsweredBlocks,
  buildWatchingStatusSection,
  buildForkToChannelModalView,
  buildAbortConfirmationModalView,
  formatThreadThinkingMessage,
  buildAttachThinkingFileButton,
  computeAutoCompactThreshold,
  DEFAULT_CONTEXT_WINDOW,
} from './blocks.js';
import {
  getAvailableModels,
  isModelAvailable,
  refreshModelCache,
  getModelInfo,
} from './model-cache.js';
import { uploadMarkdownAndPngWithResponse, extractTailWithFormatting, uploadFilesToThread } from './streaming.js';
import { markAborted, isAborted, clearAborted } from './abort-tracker.js';
import { markFfAborted, isFfAborted, clearFfAborted } from './ff-abort-tracker.js';
import { markdownToSlack, formatTimeRemaining, stripMarkdownCodeFence } from './utils.js';
import { parseCommand, extractInlineMode, UPDATE_RATE_DEFAULT, MESSAGE_SIZE_DEFAULT, THINKING_MESSAGE_SIZE } from './commands.js';
import { toUserMessage, SlackBotError, Errors } from './errors.js';
import { processSlackFiles, SlackFile } from './file-handler.js';
import { buildMessageContent, ContentBlock } from './content-builder.js';
import { withSlackRetry, withRetry } from './retry.js';
import {
  startWatching,
  stopWatching,
  isWatching,
  updateWatchRate,
  getWatcher,
  onSessionCleared,
  stopAllWatchers,
  postTerminalMessage,
  WatchState,
} from './terminal-watcher.js';
import {
  getSessionFilePath,
  sessionFileExists,
  readLastUserMessageUuid,
  extractPlanFilePathFromInput,
} from './session-reader.js';
import { syncMessagesFromOffset, MessageSyncState } from './message-sync.js';
import {
  flushActivityBatch,
  postThinkingToThread,
  postStartingToThread,
  postErrorToThread,
  postResponseToThread,
} from './activity-thread.js';
import fs from 'fs';

// Answer directory for file-based communication with MCP subprocess
const ANSWER_DIR = '/tmp/ccslack-answers';

// Processing state constants for activity tracking
const THINKING_TRUNCATE_LENGTH = 500;
const MAX_LIVE_ENTRIES = 300;  // Switch to rolling window if exceeded
const ROLLING_WINDOW_SIZE = 20; // Show last N entries when in rolling mode
const STATUS_UPDATE_INTERVAL = 1000; // TEMP: 1s for testing spinner updates

// Processing state for real-time activity tracking
interface ProcessingState {
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted' | 'generating';
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  thinkingBlockCount: number;
  startTime: number;
  lastUpdateTime: number;
  // Live config values (can be updated mid-query via commands)
  updateRateSeconds: number;
  // Activity log entries (preserved for modal)
  activityLog: ActivityEntry[];
  // Temporary state for accumulating thinking content
  currentThinkingIndex: number | null;
  currentThinkingContent: string;
  // Track current tool_use block index for detecting tool completion
  currentToolUseIndex: number | null;
  // Spinner state (cycles with each update to show bot is alive)
  spinnerIndex: number;
  // Only populated at completion (from result message)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;  // For accurate context % calculation
  cacheCreationInputTokens?: number;  // Cumulative cache creation tokens
  // Per-turn usage from last assistant message (CLI uses per-turn, not cumulative)
  perTurnInputTokens?: number;
  perTurnCacheReadInputTokens?: number;
  perTurnCacheCreationInputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;  // From SDK ModelUsage - for accurate auto-compact threshold
  costUsd?: number;
  durationMs?: number;
  // Session tracking for status display
  sessionId?: string;  // Updated when SDK reports session ID
  contextPercent?: number;  // Context usage percentage
  compactPercent?: number;  // Percent remaining until auto-compact
  tokensToCompact?: number;  // Tokens remaining before auto-compact triggers
  // Rate limit tracking
  rateLimitHits: number;
  rateLimitNotified: boolean;
  // ExitPlanMode tool tracking (for CLI-fidelity plan approval)
  exitPlanModeIndex: number | null;
  exitPlanModeInputJson: string;
  exitPlanModeInput: ExitPlanModeInput | null;
  // Tool input tracking for all tools (for activity display + plan file path extraction)
  toolInputs: Map<number, string>;      // Accumulated JSON by tool index
  toolUseIds: Map<number, string>;      // Tool use ID by tool index (for matching with tool_result)
  planFilePath: string | null;
  // Upload failure tracking for retry button
  uploadFailed?: boolean;
  // Thread-based activity tracking
  activityThreadMsgTs: string | null;      // Current thread message being edited
  activityBatch: ActivityEntry[];          // Entries waiting to post
  activityBatchStartIndex: number;         // First entry index in current batch
  lastActivityPostTime: number;            // For rate limiting thread posts
  threadParentTs: string | null;           // Status message ts (thread parent for activity entries)
  charLimit: number;                       // Character limit for thread messages
  // Track posted batch for updates when tool_result arrives
  postedBatchTs: string | null;            // Ts of most recently posted batch
  postedBatchToolUseIds: Set<string>;      // tool_use_ids in the posted batch
  // Thinking update race condition protection
  pendingThinkingUpdate: Promise<void> | null;  // Track in-flight thinking update
  // Compaction tracking (shared by /compact and auto-compact)
  compactMsgTs: string | null;            // Message ts to update on completion
  compactStartTime: number | null;        // When compaction started
  compactPreTokens: number | null;        // Tokens before compaction (from compact_boundary)
  compactIsManual: boolean;               // true for /compact, false for auto-compact
}

/**
 * ExitPlanMode tool input structure.
 * Mirrors the allowedPrompts field from the SDK.
 */
interface ExitPlanModeInput {
  allowedPrompts?: { tool: string; prompt: string }[];
}

// Spinner frames for visual "alive" indicator during processing
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

// Tool approval reminder configuration (matches MCP ask_user behavior)
const TOOL_APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOOL_APPROVAL_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const TOOL_APPROVAL_MAX_REMINDERS = Math.floor(TOOL_APPROVAL_EXPIRY_MS / TOOL_APPROVAL_REMINDER_INTERVAL_MS); // 42 reminders

// Store pending messages when concurrent session detected
interface PendingMessage {
  channelId: string;
  userId: string | undefined;
  userText: string;
  originalTs?: string;
  threadTs?: string;
}
const pendingMessages = new Map<string, PendingMessage>();

// Store pending multi-select selections (before user clicks Submit)
const pendingSelections = new Map<string, string[]>();

// Track busy conversations (processing a request)
// Exported for testing
export const busyConversations = new Set<string>();

// Track active queries for abort capability
interface ActiveQuery {
  query: ClaudeQuery;
  statusMsgTs: string;           // Combined message: Activity log + Status panel
  mode: PermissionMode;
  model?: string;
  processingState: ProcessingState;
}
const activeQueries = new Map<string, ActiveQuery>();

// Track pending plan approvals (for maintaining busy state and :eyes:)
interface PendingPlanApproval {
  originalTs: string;
  channelId: string;
  threadTs?: string;
  statusMsgTs?: string;           // Reuse status message after approval
  activityLog?: ActivityEntry[];  // Continue activity log after approval
}
export const pendingPlanApprovals = new Map<string, PendingPlanApproval>();

// Mutexes for serializing updates (prevents abort race conditions)
const updateMutexes = new Map<string, Mutex>();

// Get permalink URL for a message using Slack API
// Returns workspace-specific URL that works properly on iOS mobile app
async function getMessagePermalink(
  client: any,
  channel: string,
  messageTs: string
): Promise<string> {
  try {
    const result = await withSlackRetry(() =>
      client.chat.getPermalink({
        channel,
        message_ts: messageTs,
      })
    ) as { ok?: boolean; permalink?: string };
    if (result.ok && result.permalink) {
      return result.permalink;
    }
  } catch (error) {
    console.error('[getMessagePermalink] Failed to get permalink, using fallback:', error);
  }
  // Fallback to manual URL construction (works on desktop but may not open in iOS app)
  return `https://slack.com/archives/${channel}/p${messageTs.replace('.', '')}`;
}

// Helper for sleeping (used in retry logic)
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip ANSI escape codes from text (colors, bold, etc.).
 * Handles CSI sequences: ESC [ <params> <command>
 * Example: "\x1B[32m✓\x1B[0m" → "✓"
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Read thinking content from session file by timestamp and charCount.
 * Uses timestamp as primary match, charCount as verification.
 *
 * @param sessionId - Session ID to look up
 * @param thinkingTimestamp - entry.timestamp for matching
 * @param thinkingCharCount - content.length for verification
 * @param workingDir - Working directory for session file lookup (default: cwd)
 * @returns Thinking content if found, null otherwise
 */
async function getThinkingContentFromSession(
  sessionId: string,
  thinkingTimestamp: number,
  thinkingCharCount: number,
  workingDir: string = process.cwd()
): Promise<string | null> {
  try {
    const filePath = getSessionFilePath(sessionId, workingDir);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`[getThinkingContentFromSession] Session file not found: ${filePath}`);
      return null;
    }

    // Read and parse the JSONL file
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Search for assistant messages with thinking blocks
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        // Only look at assistant messages
        if (parsed.type !== 'assistant' || !parsed.message?.content) continue;

        const msgTimestamp = new Date(parsed.timestamp).getTime();
        const msgContent = parsed.message.content;

        // Look for thinking blocks in the content
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'thinking' && block.thinking) {
              const thinkingContent = block.thinking as string;

              // Match by timestamp (primary) and charCount (verification)
              // Allow some timestamp tolerance (±1 second) since we may have rounding
              const timestampMatch = Math.abs(msgTimestamp - thinkingTimestamp) < 1000;
              const charCountMatch = thinkingContent.length === thinkingCharCount;

              if (timestampMatch && charCountMatch) {
                console.log(`[getThinkingContentFromSession] Found matching thinking: ${thinkingContent.length} chars`);
                return thinkingContent;
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    console.error('[getThinkingContentFromSession] No matching thinking entry found');
    return null;
  } catch (error) {
    console.error('[getThinkingContentFromSession] Failed:', error);
    return null;
  }
}

/**
 * Update thinking message with retry logic.
 * - Retries transient errors (rate limits, network) up to maxAttempts times
 * - Does NOT retry permanent errors (message_not_found, channel_not_found)
 * - On final failure, logs error to main channel with link
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param messageTs - Message timestamp to update
 * @param text - New text content
 * @param maxAttempts - Maximum retry attempts
 * @param mainChannelId - Channel ID for error logging
 * @returns true if successful, false on failure
 */
async function updateThinkingMessageWithRetry(
  client: WebClient,
  channelId: string,
  messageTs: string,
  text: string,
  maxAttempts: number,
  mainChannelId: string
): Promise<boolean> {
  const PERMANENT_ERRORS = ['message_not_found', 'channel_not_found', 'msg_too_long', 'no_permission'];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.chat.update({ channel: channelId, ts: messageTs, text });
      return true;
    } catch (error: any) {
      const errorCode = error?.data?.error || error?.code;

      // Don't retry permanent errors - fail immediately
      if (PERMANENT_ERRORS.includes(errorCode)) {
        console.error(`[updateThinkingMessageWithRetry] Permanent error: ${errorCode}`);
        break;  // Exit loop, log error below
      }

      if (attempt === maxAttempts) {
        break;  // Max attempts reached, log error below
      }

      console.log(`[updateThinkingMessageWithRetry] Attempt ${attempt} failed, retrying... (${errorCode})`);
      await sleep(1000 * attempt);  // Backoff: 1s, 2s, 3s, 4s, 5s
    }
  }

  // Log error to main channel with link
  try {
    const msgLink = await getMessagePermalink(client, channelId, messageTs);
    await client.chat.postMessage({
      channel: mainChannelId,
      text: `:warning: Failed to update thinking message. File was uploaded but <${msgLink}|message> could not be updated.`,
    });
  } catch (linkError) {
    // If we can't even get permalink, just log without link
    await client.chat.postMessage({
      channel: mainChannelId,
      text: `:warning: Failed to update thinking message. File was uploaded but message could not be updated.`,
    });
  }
  return false;
}

function getUpdateMutex(conversationKey: string): Mutex {
  if (!updateMutexes.has(conversationKey)) {
    updateMutexes.set(conversationKey, new Mutex());
  }
  return updateMutexes.get(conversationKey)!;
}

function cleanupMutex(conversationKey: string): void {
  updateMutexes.delete(conversationKey);
}

// Track pending tool approvals (for manual approval mode)
interface PendingToolApproval {
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  messageTs: string;
  channelId: string;
  threadTs?: string;
}
const pendingToolApprovals = new Map<string, PendingToolApproval>();

// Track tool approval reminders (matches MCP ask_user pattern)
const toolApprovalReminderIntervals = new Map<string, NodeJS.Timeout>();
const toolApprovalReminderCounts = new Map<string, number>();
const toolApprovalReminderStartTimes = new Map<string, number>();

// Track pending SDK AskUserQuestion prompts
interface PendingSdkQuestion {
  resolve: (answer: string) => void;
  messageTs: string;
  channelId: string;
  threadTs?: string;
  question: string;  // For showing in answered state
}
const pendingSdkQuestions = new Map<string, PendingSdkQuestion>();

// Track pending multi-select selections for SDK questions
const pendingSdkMultiSelections = new Map<string, string[]>();

// Helper to get unique conversation key (channel + thread)
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

// Centralized session config reading - always gets fresh values for live updates
function getLiveSessionConfig(channelId: string, threadTs?: string) {
  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);
  return {
    updateRateSeconds: session?.updateRateSeconds ?? UPDATE_RATE_DEFAULT,
    threadCharLimit: session?.threadCharLimit ?? MESSAGE_SIZE_DEFAULT,
    stripEmptyTag: session?.stripEmptyTag ?? false,
  };
}

// Helper to check if conversation is busy and respond if so
// Returns true if busy (caller should return early), false if not busy
// Also removes :eyes: reaction if originalTs is provided
async function checkBusyAndRespond(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  conversationKey: string,
  originalTs?: string
): Promise<boolean> {
  if (busyConversations.has(conversationKey)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I'm busy with the current request. Please wait for it to complete, or click Abort.",
    });
    // Remove :eyes: reaction since we're not processing this message
    if (originalTs) {
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: originalTs,
          name: 'eyes',
        });
      } catch {
        // Ignore - reaction may already be removed
      }
    }
    return true; // Was busy
  }
  return false; // Not busy
}

/**
 * Rate limit stress test - updates spinner for X seconds
 * Tests Slack API rate limits by making continuous updates
 */
async function runWaitTest(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  seconds: number,
  mode: PermissionMode,
  originalTs: string | undefined
): Promise<void> {
  const startTime = Date.now();
  let spinnerIndex = 0;
  let rateLimitHits = 0;
  let updateCount = 0;

  // Remove eyes reaction first
  if (originalTs) {
    try {
      await client.reactions.remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch {
      // Ignore
    }
  }

  // Post initial status panel
  const statusMsg = (await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildStatusPanelBlocks({
        status: 'thinking',
        mode,
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey: `wait_test_${channelId}`,
        spinner: SPINNER_FRAMES[0],
      }),
      text: `Rate limit test: ${seconds}s`,
    })
  )) as { ts?: string };

  const statusMsgTs = statusMsg.ts!;
  console.log(`[WaitTest] Started ${seconds}s test, status msg: ${statusMsgTs}`);

  // Create a promise that resolves when the test is complete
  await new Promise<void>((resolve) => {
    const updateInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      const elapsedSec = elapsed / 1000;

      // Check if done
      if (elapsedSec >= seconds) {
        clearInterval(updateInterval);

        // Final update - completion
        try {
          await withSlackRetry(() =>
            client.chat.update({
              channel: channelId,
              ts: statusMsgTs,
              blocks: buildStatusPanelBlocks({
                status: 'complete',
                mode,
                toolsCompleted: updateCount,
                elapsedMs: elapsed,
                conversationKey: `wait_test_${channelId}`,
              }),
              text: `Rate limit test complete`,
            })
          );

          // Post summary
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text:
              `:white_check_mark: *Wait test complete*\n` +
              `Duration: ${seconds}s\n` +
              `Updates attempted: ${updateCount}\n` +
              `Rate limit hits: ${rateLimitHits}`,
          });
        } catch (err) {
          console.error('[WaitTest] Final update error:', err);
        }

        console.log(
          `[WaitTest] Complete - ${updateCount} updates, ${rateLimitHits} rate limits`
        );
        resolve();
        return;
      }

      // Update spinner
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      const spinner = SPINNER_FRAMES[spinnerIndex];
      updateCount++;

      try {
        await withSlackRetry(() =>
          client.chat.update({
            channel: channelId,
            ts: statusMsgTs,
            blocks: buildStatusPanelBlocks({
              status: 'thinking',
              mode,
              toolsCompleted: updateCount,
              elapsedMs: elapsed,
              conversationKey: `wait_test_${channelId}`,
              spinner,
            }),
            text: `Rate limit test: ${elapsedSec.toFixed(1)}s / ${seconds}s`,
          })
        );
      } catch (err: unknown) {
        // Log rate limit specifically
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          err.code === 'slack_webapi_platform_error'
        ) {
          rateLimitHits++;
          console.log(
            `[WaitTest] Rate limit hit #${rateLimitHits} at ${elapsedSec.toFixed(1)}s`
          );
        } else {
          console.error('[WaitTest] Update error:', err);
        }
      }
    }, STATUS_UPDATE_INTERVAL);
  });
}

/**
 * Handle compaction start - posts :gear: message when compaction begins.
 * Shared by /compact and auto-compact flows.
 */
async function handleCompactionStart(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  processingState: ProcessingState,
  isManual: boolean,
  handleRateLimit: () => void
): Promise<void> {
  // Skip if already tracking compaction (prevents duplicate messages)
  if (processingState.compactMsgTs) return;

  processingState.compactStartTime = Date.now();
  processingState.compactIsManual = isManual;

  const prefix = isManual ? 'Compacting' : 'Auto-compacting';
  const compactMsg = await withSlackRetry(
    async () =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:gear: ${prefix} context...`,
      }),
    { onRateLimit: handleRateLimit }
  );

  processingState.compactMsgTs = (compactMsg as { ts?: string })?.ts ?? null;
  console.log(`[Compact] Started (manual=${isManual})`);
}

/**
 * Handle compaction end - updates :gear: message to :checkered_flag:.
 * Shared by /compact and auto-compact flows.
 */
async function handleCompactionEnd(
  client: any,
  channelId: string,
  processingState: ProcessingState,
  handleRateLimit: () => void
): Promise<void> {
  if (!processingState.compactMsgTs || !processingState.compactStartTime) return;

  const elapsed = ((Date.now() - processingState.compactStartTime) / 1000).toFixed(1);
  const prefix = processingState.compactIsManual ? 'Compacted' : 'Auto-compacted';
  const tokenInfo = processingState.compactPreTokens
    ? `Was: ${processingState.compactPreTokens.toLocaleString()} tokens`
    : '';

  try {
    await withSlackRetry(
      async () =>
        client.chat.update({
          channel: channelId,
          ts: processingState.compactMsgTs!,
          text: `:checkered_flag: ${prefix} context | ${tokenInfo} | ${elapsed}s`,
        }),
      { onRateLimit: handleRateLimit }
    );
  } catch (error) {
    console.error('[Compact] Failed to update completion message:', error);
  }

  // Clear tracking
  processingState.compactMsgTs = null;
  processingState.compactStartTime = null;
  processingState.compactPreTokens = null;
}

/**
 * Compact session - reduces context size by summarizing conversation
 * Sends /compact as prompt to resumed session and tracks progress
 */
async function runCompactSession(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  session: Session,
  originalTs: string | undefined,
  conversationKey: string
): Promise<void> {
  const startTime = Date.now();

  // Initialize ProcessingState for abort capability (all required fields)
  const processingState: ProcessingState = {
    status: 'thinking',
    toolsCompleted: 0,
    thinkingBlockCount: 0,
    startTime,
    lastUpdateTime: 0,
    updateRateSeconds: session.updateRateSeconds ?? UPDATE_RATE_DEFAULT,
    activityLog: [{ timestamp: startTime, type: 'starting' }],
    currentThinkingIndex: null,
    currentThinkingContent: '',
    currentToolUseIndex: null,
    spinnerIndex: 0,
    rateLimitHits: 0,
    rateLimitNotified: false,
    exitPlanModeIndex: null,
    exitPlanModeInputJson: '',
    exitPlanModeInput: null,
    toolInputs: new Map(),
    toolUseIds: new Map(),
    planFilePath: null,
    uploadFailed: false,
    activityThreadMsgTs: null,
    activityBatch: [],
    activityBatchStartIndex: 0,
    lastActivityPostTime: 0,
    threadParentTs: null,
    charLimit: MESSAGE_SIZE_DEFAULT,
    postedBatchTs: null,
    postedBatchToolUseIds: new Set(),
    pendingThinkingUpdate: null,
    // Compaction tracking (shared by /compact and auto-compact)
    compactMsgTs: null,
    compactStartTime: null,
    compactPreTokens: null,
    compactIsManual: true,  // /compact is manual
  };

  // Post initial status message
  const statusMsg = (await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildStatusPanelBlocks({
        status: 'thinking',
        mode: session.mode,
        model: session.model,
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey,
        spinner: SPINNER_FRAMES[0],
        customStatus: 'Compacting session...',
      }),
      text: 'Compacting session...',
    })
  )) as { ts?: string };

  const statusMsgTs = statusMsg.ts!;
  console.log(`[Compact] Started compaction for session ${session.sessionId}`);

  // Start Claude query with /compact as prompt
  const claudeQuery = startClaudeQuery('/compact', {
    sessionId: session.sessionId ?? undefined,
    workingDir: session.workingDir,
    mode: session.mode,
    model: session.model,
  });

  // Track busy state and register for abort capability
  busyConversations.add(conversationKey);
  activeQueries.set(conversationKey, {
    query: claudeQuery,
    statusMsgTs,
    mode: session.mode,
    processingState,
  });

  // Track compaction state
  let compactBoundaryFound = false;
  let newSessionId: string | null = null;
  let modelName: string | undefined;
  let errorOccurred = false;
  let errorMessage = '';

  // Spinner update timer - uses setTimeout pattern to honor updateRateSeconds from session
  let spinnerTimer: NodeJS.Timeout | undefined;
  const scheduleSpinnerUpdate = () => {
    const intervalMs = processingState.updateRateSeconds * 1000;
    spinnerTimer = setTimeout(async () => {
      processingState.spinnerIndex = (processingState.spinnerIndex + 1) % SPINNER_FRAMES.length;
      const elapsed = Date.now() - startTime;

      try {
        await withSlackRetry(() =>
          client.chat.update({
            channel: channelId,
            ts: statusMsgTs,
            blocks: buildStatusPanelBlocks({
              status: 'thinking',
              mode: session.mode,
              model: modelName || session.model,
              toolsCompleted: 0,
              elapsedMs: elapsed,
              conversationKey,
              spinner: SPINNER_FRAMES[processingState.spinnerIndex],
              customStatus: compactBoundaryFound ? 'Finalizing...' : 'Compacting session...',
            }),
            text: 'Compacting session...',
          })
        );
      } catch {
        // Ignore update errors
      }

      scheduleSpinnerUpdate();  // Reschedule with current rate
    }, intervalMs);
  };
  scheduleSpinnerUpdate();

  try {
    // Process SDK messages
    for await (const msg of claudeQuery) {
      // Check for abort
      if (isAborted(conversationKey)) {
        console.log(`[Compact] Aborted by user`);
        break;
      }

      // Capture session ID and model from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        newSessionId = (msg as any).session_id;
        modelName = (msg as any).model;
        console.log(`[Compact] New session: ${newSessionId}, model: ${modelName}`);
      }

      // Detect compaction START via status:compacting
      if (msg.type === 'system' &&
          (msg as any).subtype === 'status' &&
          (msg as any).status === 'compacting') {
        await handleCompactionStart(client, channelId, threadTs, processingState, true, () => {});
      }

      // Capture pre_tokens from compact_boundary (END marker)
      if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
        compactBoundaryFound = true;
        const metadata = (msg as any).compact_metadata;
        processingState.compactPreTokens = metadata?.pre_tokens ?? null;
        console.log(`[Compact] Boundary - pre_tokens: ${processingState.compactPreTokens}`);
      }
    }
  } catch (err: any) {
    errorOccurred = true;
    errorMessage = err.message || String(err);
    console.error(`[Compact] Error: ${errorMessage}`);
  } finally {
    if (spinnerTimer) clearTimeout(spinnerTimer);
    activeQueries.delete(conversationKey);
    clearAborted(conversationKey);
    busyConversations.delete(conversationKey);
    cleanupMutex(conversationKey);
  }

  const elapsed = Date.now() - startTime;
  const wasAborted = isAborted(conversationKey);

  // Update :gear: message with completion (if posted and not aborted)
  if (!wasAborted && !errorOccurred) {
    await handleCompactionEnd(client, channelId, processingState, () => {});
  }

  // Update final status
  if (wasAborted) {
    // Aborted state
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'aborted',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey,
          customStatus: 'Compaction aborted',
        }),
        text: 'Compaction aborted',
      })
    );
  } else if (errorOccurred) {
    // Error state
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'error',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey,
          customStatus: `Compaction failed: ${errorMessage}`,
        }),
        text: `Compaction failed: ${errorMessage}`,
      })
    );
  } else if (compactBoundaryFound) {
    // Success - update session with new ID if changed
    if (newSessionId && newSessionId !== session.sessionId) {
      await saveSession(channelId, { sessionId: newSessionId });
      console.log(`[Compact] Session updated: ${session.sessionId} → ${newSessionId}`);
    }

    // Build success message
    const tokenInfo = processingState.compactPreTokens
      ? `Tokens before: ${processingState.compactPreTokens.toLocaleString()}`
      : 'Context compacted';

    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'complete',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey,
          customStatus: `Compaction complete | ${tokenInfo}`,
        }),
        text: `Compaction complete | ${tokenInfo}`,
      })
    );

    // Post success message
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:white_check_mark: *Session compacted*\n${tokenInfo}\nDuration: ${(elapsed / 1000).toFixed(1)}s`,
    });
  } else {
    // No compact boundary found - may have been treated as text
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'complete',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey,
          customStatus: 'Compaction processed',
        }),
        text: 'Compaction processed',
      })
    );
  }

  // Remove eyes reaction now that compaction is complete
  if (originalTs) {
    try {
      await client.reactions.remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch {
      // Ignore
    }
  }
}

/**
 * Clear session - clears conversation history and starts fresh
 * Sends /clear as prompt to resumed session and tracks progress
 * @param postingThreadTs - Where to post messages (effectiveThreadTs)
 * @param sessionThreadTs - Original thread context for session management
 */
async function runClearSession(
  client: any,
  channelId: string,
  postingThreadTs: string | undefined,
  sessionThreadTs: string | undefined,
  session: Session,
  originalTs: string | undefined
): Promise<void> {
  const startTime = Date.now();
  let spinnerIndex = 0;

  // Remove eyes reaction first
  if (originalTs) {
    try {
      await client.reactions.remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch {
      // Ignore
    }
  }

  // Post initial status message
  const statusMsg = (await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildStatusPanelBlocks({
        status: 'thinking',
        mode: session.mode,
        model: session.model,
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey: `clear_${channelId}`,
        spinner: SPINNER_FRAMES[0],
        customStatus: 'Clearing session history...',
      }),
      text: 'Clearing session history...',
    })
  )) as { ts?: string };

  const statusMsgTs = statusMsg.ts!;
  console.log(`[Clear] Started clear for session ${session.sessionId}`);

  // Start Claude query with /clear as prompt
  const claudeQuery = startClaudeQuery('/clear', {
    sessionId: session.sessionId ?? undefined,
    workingDir: session.workingDir,
    mode: session.mode,
    model: session.model,
  });

  // Track clear state
  let newSessionId: string | null = null;
  let modelName: string | undefined;
  let errorOccurred = false;
  let errorMessage = '';

  // Spinner update timer
  const spinnerTimer = setInterval(async () => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    const elapsed = Date.now() - startTime;

    try {
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: statusMsgTs,
          blocks: buildStatusPanelBlocks({
            status: 'thinking',
            mode: session.mode,
            model: modelName || session.model,
            toolsCompleted: 0,
            elapsedMs: elapsed,
            conversationKey: `clear_${channelId}`,
            spinner: SPINNER_FRAMES[spinnerIndex],
            customStatus: 'Clearing session history...',
          }),
          text: 'Clearing session history...',
        })
      );
    } catch {
      // Ignore update errors
    }
  }, STATUS_UPDATE_INTERVAL);

  try {
    // Process SDK messages
    for await (const msg of claudeQuery) {
      // Capture session ID and model from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        newSessionId = (msg as any).session_id;
        modelName = (msg as any).model;
        console.log(`[Clear] New session: ${newSessionId}, model: ${modelName}`);
      }

      // Note: SDK doesn't emit clear_boundary - we detect success via new session ID
    }
  } catch (err: any) {
    errorOccurred = true;
    errorMessage = err.message || String(err);
    console.error(`[Clear] Error: ${errorMessage}`);
  } finally {
    clearInterval(spinnerTimer);
  }

  const elapsed = Date.now() - startTime;

  // Update final status
  if (errorOccurred) {
    // Error state
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'error',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey: `clear_${channelId}`,
          customStatus: `Clear failed: ${errorMessage}`,
        }),
        text: `Clear failed: ${errorMessage}`,
      })
    );
  } else {
    // Success - /clear completed
    // IMPORTANT: SDK does NOT create a new session - /clear as prompt is just text
    // To actually clear, we set sessionId to NULL so next message starts fresh
    console.log(`[Clear] Completed. Setting sessionId to null (was: ${session.sessionId})`);

    // Track old session ID for cleanup, then set sessionId to null
    const previousIds = session.previousSessionIds ?? [];
    if (session.sessionId) {
      previousIds.push(session.sessionId);
    }

    await saveSession(channelId, {
      sessionId: null,  // Next message will start fresh without resuming
      previousSessionIds: previousIds,
      lastUsage: undefined,  // Clear stale usage data so /status and /context show fresh state
      mode: 'default',  // Reset to safe default mode
      planFilePath: null,  // Reset plan file path on clear
    });

    // Stop terminal watcher if active (session is being cleared)
    onSessionCleared(channelId, sessionThreadTs);

    // Clear synced message UUIDs (for /ff resumability)
    await clearSyncedMessageUuids(channelId, sessionThreadTs);

    console.log(`[Clear] Session cleared. Previous sessions tracked: ${previousIds.length}`);

    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: 'complete',
          mode: session.mode,
          model: modelName || session.model,
          toolsCompleted: 0,
          elapsedMs: elapsed,
          conversationKey: `clear_${channelId}`,
          customStatus: 'Session cleared',
        }),
        text: 'Session cleared',
      })
    );

    // Post success message
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: `:wastebasket: *Session history cleared*\nStarting fresh. Your next message begins a new conversation.\nDuration: ${(elapsed / 1000).toFixed(1)}s`,
    });

    // Show current configuration after clear
    const updatedSession = getSession(channelId);
    if (updatedSession) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        blocks: buildStatusDisplayBlocks({
          sessionId: updatedSession.sessionId,
          mode: updatedSession.mode,
          workingDir: updatedSession.workingDir,
          lastActiveAt: updatedSession.lastActiveAt,
          pathConfigured: updatedSession.pathConfigured,
          configuredBy: updatedSession.configuredBy,
          configuredAt: updatedSession.configuredAt,
          lastUsage: updatedSession.lastUsage,
          maxThinkingTokens: updatedSession.maxThinkingTokens,
          updateRateSeconds: updatedSession.updateRateSeconds,
          messageSize: updatedSession.threadCharLimit,
        }),
        text: 'Session status',
      });
    }
  }
}

/** Pacing delay between messages in /ff sync (milliseconds) */
const FF_PACING_DELAY_MS = 500;

/**
 * Handle /ff (fast-forward) command - sync missed terminal messages and start watching.
 * Used when user forgot to use /watch and did work directly in terminal.
 *
 * Features:
 * - UUID tracking: tracks all synced message UUIDs (handles gaps, crash-safe)
 * - Infinite retries: never gives up on rate limits, uses exponential backoff
 * - Pacing: 500ms delay between messages to reduce rate limit hits
 * - Progress updates: shows sync progress to user via anchor message updates
 *
 * Threading pattern (after thread-based output change):
 * - Anchor message posted to main channel (no thread_ts)
 * - All synced messages posted as thread replies to anchor
 * - Progress updates anchor in place (no delete/repost)
 * - After sync: anchor shows completion + Stop Watching button
 */
async function handleFastForwardSync(
  client: any,
  channelId: string,
  threadTs: string | undefined,  // Always undefined now (rejected in commands.ts)
  session: Session,
  userId?: string
): Promise<void> {
  // Since /ff is now rejected in threads, we always use main channel session
  const sessionId = session.sessionId;
  const conversationKey = channelId;  // Always main channel

  // Clear any previous abort flag
  clearFfAborted(conversationKey);

  if (!sessionId) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':warning: No active session. Start a conversation first.',
    });
    return;
  }

  // Check if session file exists
  if (!sessionFileExists(sessionId, session.workingDir)) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':warning: Session file not found. The session may have been deleted.',
    });
    return;
  }

  // Mark conversation as busy to block queries during /ff sync
  // This will remain set while watching - removed when stopWatching is called
  busyConversations.add(conversationKey);

  const updateRate = session.updateRateSeconds ?? UPDATE_RATE_DEFAULT;
  const terminalCommand = `cd ${session.workingDir} && claude --dangerously-skip-permissions --resume ${sessionId}`;

  // Helper to build anchor blocks with progress
  // anchorTs is required for 'watching' status to enable stop button
  const buildAnchorBlocks = (status: 'syncing' | 'watching' | 'stopped', synced?: number, total?: number, anchorTs?: string) => {
    if (status === 'syncing') {
      const progressText = total !== undefined
        ? `:fast_forward: Syncing terminal messages... ${synced ?? 0}/${total}`
        : ':fast_forward: Syncing terminal messages...';
      return [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: progressText },
        },
        {
          type: 'actions',
          block_id: `ff_sync_${sessionId}`,
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: 'Stop FF' },
            action_id: 'stop_ff_sync',
            style: 'danger',
            value: JSON.stringify({ sessionId }),
          }],
        },
      ];
    }

    if (status === 'stopped') {
      const remaining = (total ?? 0) - (synced ?? 0);
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:stop_sign: Sync stopped at ${synced}/${total}.\n:point_right: Run \`/ff\` again to sync remaining ${remaining} message(s).`,
          },
        },
      ];
    }

    // status === 'watching' - show terminal command + Stop Watching button
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: Synced ${total ?? 0} message(s) from terminal.`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Continue in Terminal' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Run this command to continue your session locally:' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '```' + terminalCommand + '```' },
      },
      {
        type: 'divider',
      },
      buildWatchingStatusSection(sessionId, updateRate, anchorTs),
    ];
  };

  // Post anchor message to main channel (no thread_ts)
  const anchorMsg = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      // No thread_ts - this is the anchor in main channel
      text: ':fast_forward: Syncing terminal messages...',
      blocks: buildAnchorBlocks('syncing'),
    })
  );
  const anchorTs = (anchorMsg as { ts?: string }).ts!;

  try {
    // Prepare sync state - all messages go to anchor thread
    const filePath = getSessionFilePath(sessionId, session.workingDir);
    const syncState: MessageSyncState = {
      conversationKey,
      channelId,
      threadTs: anchorTs,  // Posts to anchor thread
      sessionId,
      workingDir: session.workingDir,
      client,
    };

    // Create WatchState for postTerminalMessage callback
    const watchState: WatchState = {
      conversationKey,
      channelId,
      threadTs: anchorTs,  // Posts to anchor thread
      sessionId,
      workingDir: session.workingDir,
      fileOffset: 0,  // Not used for posting
      intervalId: null as any,  // Not used for posting
      statusMsgTs: anchorTs,
      client,
      updateRateMs: updateRate * 1000,
      userId,
      activityMessages: new Map(),  // Track activity ts during sync (update-in-place)
      planFilePath: null,  // Not used for /ff
    };

    let lastReportedTotal = 0;

    // Run sync with progress tracking
    const syncResult = await syncMessagesFromOffset(syncState, filePath, 0, {
      infiniteRetry: true,
      isAborted: () => isFfAborted(conversationKey),
      pacingDelayMs: FF_PACING_DELAY_MS,
      postTextMessage: (s, msg) => postTerminalMessage(watchState, msg),
      activityMessages: watchState.activityMessages,
      charLimit: session.threadCharLimit ?? MESSAGE_SIZE_DEFAULT,
      onProgress: async (synced, total) => {
        lastReportedTotal = total;
        // Update anchor in place (no delete/repost)
        await withSlackRetry(() =>
          client.chat.update({
            channel: channelId,
            ts: anchorTs,
            text: `:fast_forward: Syncing terminal messages... ${synced}/${total}`,
            blocks: buildAnchorBlocks('syncing', synced, total),
          })
        );
      },
    });

    // Clear abort flag
    clearFfAborted(conversationKey);

    // Handle "already up to date" case
    if (syncResult.totalToSync === 0) {
      // Update anchor to show "up to date" + terminal command + Stop Watching button
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: anchorTs,
          text: ':white_check_mark: Already up to date.',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: ':white_check_mark: Already up to date. No new terminal messages to sync.' },
            },
            { type: 'divider' },
            {
              type: 'header',
              text: { type: 'plain_text', text: 'Continue in Terminal' },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Run this command to continue your session locally:' },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '```' + terminalCommand + '```' },
            },
            { type: 'divider' },
            buildWatchingStatusSection(sessionId, updateRate, anchorTs),
          ],
        })
      );
      // Start watching with anchor as thread parent
      const watchResult = startWatching(channelId, anchorTs, session, client, anchorTs, userId);
      if (!watchResult.success) {
        // Remove from busy state since watcher failed to start
        busyConversations.delete(conversationKey);
      }
      return;
    }

    const totalToSync = lastReportedTotal || syncResult.totalToSync;
    const syncedCount = syncResult.syncedCount;
    const wasStopped = syncResult.wasAborted;

    // Handle stopped case
    if (wasStopped) {
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: anchorTs,
          text: `:stop_sign: Sync stopped.`,
          blocks: buildAnchorBlocks('stopped', syncedCount, totalToSync),
        })
      );
      // Remove from busy state since we're not transitioning to watching
      busyConversations.delete(conversationKey);
      return;  // Don't start watching after stop
    }

    // Update anchor to show completion + terminal command + Stop Watching button
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: anchorTs,
        text: `:white_check_mark: Synced ${totalToSync} message(s) from terminal.`,
        blocks: buildAnchorBlocks('watching', totalToSync, totalToSync, anchorTs),
      })
    );

    // Start watching with anchor as thread parent
    const result = startWatching(channelId, anchorTs, session, client, anchorTs, userId);
    if (!result.success) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: anchorTs,
        text: `:warning: Could not start watching: ${result.error}`,
      });
      // Remove from busy state since watcher failed to start
      busyConversations.delete(conversationKey);
    }

  } catch (error) {
    console.error('[FastForward] Error:', error);
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: anchorTs,
        text: `:x: Failed to sync terminal messages: ${error instanceof Error ? error.message : String(error)}`,
      })
    );
    // Remove from busy state on error
    busyConversations.delete(conversationKey);
  }
}

// Create a fork from a specific message (point-in-time fork)
// Used by "Fork here" button
async function createForkFromMessage(params: {
  channelId: string;
  sourceThreadTs?: string;   // Source thread (undefined for main channel fork)
  forkPointMessageTs: string;  // Message to fork from (via messageMap lookup)
  client: any;
  userId: string;
}): Promise<{ success: boolean; error?: string; forkThreadTs?: string }> {
  const { channelId, sourceThreadTs, forkPointMessageTs, client, userId } = params;

  // 1. Look up the message in messageMap
  const forkPoint = findForkPointMessageId(channelId, forkPointMessageTs);
  if (!forkPoint) {
    return {
      success: false,
      error: 'Message not found in conversation history. The message may be too old or from before messageMap tracking was enabled.',
    };
  }

  // 2. Verify the source session exists
  // The forkPoint contains the session ID that this message belongs to
  const sourceSessionId = forkPoint.sessionId;
  if (!sourceSessionId) {
    return {
      success: false,
      error: 'Source session not found. Cannot fork without a valid parent session.',
    };
  }

  // 3. Get the main session for inheriting config
  const mainSession = getSession(channelId);

  // 4. Build fork point link (used in anchor and thread messages)
  // Use Slack API to get workspace-specific permalink (works on iOS mobile)
  const forkPointLink = await getMessagePermalink(client, channelId, forkPointMessageTs);

  // 5. Create fork anchor in main channel
  const anchorMessage = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      text: `🔀 Point-in-time fork from this message`,
      blocks: buildForkAnchorBlocks({ forkPointLink }),
    })
  );
  const newThreadTs = (anchorMessage as { ts?: string }).ts!;

  // 6. Create forked thread session with point-in-time fork data
  await saveThreadSession(channelId, newThreadTs, {
    sessionId: null,  // Will be set when SDK creates the forked session
    forkedFrom: sourceSessionId,
    forkedFromThreadTs: sourceThreadTs,
    workingDir: mainSession?.workingDir ?? process.cwd(),
    mode: mainSession?.mode ?? 'default',
    model: mainSession?.model,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    // Path configuration inherited from main session
    pathConfigured: mainSession?.pathConfigured ?? false,
    configuredPath: mainSession?.configuredPath ?? null,
    configuredBy: mainSession?.configuredBy ?? null,
    configuredAt: mainSession?.configuredAt ?? null,
    // Point-in-time forking: store the SDK message ID to fork from
    resumeSessionAtMessageId: forkPoint.messageId,
    // Inherit other config
    maxThinkingTokens: mainSession?.maxThinkingTokens,
    updateRateSeconds: mainSession?.updateRateSeconds,
    threadCharLimit: mainSession?.threadCharLimit,
    stripEmptyTag: mainSession?.stripEmptyTag,
    planFilePath: null,  // Don't inherit plan from parent
  });

  // 7. Post first message in new thread with link to the fork point
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: newThreadTs,
      text: `_Point-in-time fork from <${forkPointLink}|this message>._`,
    })
  );

  // 8. Notify in source thread (skip for main channel forks)
  if (sourceThreadTs) {
    const newThreadLink = await getMessagePermalink(client, channelId, newThreadTs);
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: sourceThreadTs,
        text: `_Point-in-time fork created: <${newThreadLink}|view thread>_`,
      })
    );
  }

  return {
    success: true,
    forkThreadTs: newThreadTs,
  };
}

// Create a fork to a new channel (point-in-time fork to separate channel)
// Used by "Fork here" modal submission
async function createForkToChannel(params: {
  channelName: string;
  sourceChannelId: string;
  sourceMessageTs: string;
  threadTs?: string;
  conversationKey: string;
  userId: string;
  client: any;
  sdkMessageId?: string;
  sessionId?: string;
}): Promise<{ success: boolean; error?: string; newChannelId?: string }> {
  const { channelName, sourceChannelId, sourceMessageTs, threadTs, userId, client } = params;

  // 1. Use fork point from button value (no lookup needed)
  if (!params.sdkMessageId || !params.sessionId) {
    return { success: false, error: 'Missing fork point info' };
  }
  const forkPoint = { messageId: params.sdkMessageId, sessionId: params.sessionId };
  console.log(`[ForkToChannel] Fork point: ${forkPoint.messageId} in session ${forkPoint.sessionId}`);

  // 2. Create channel (let Slack validate name, show error to user if rejected)
  let createResult: any;
  try {
    createResult = await withSlackRetry(() =>
      client.conversations.create({ name: channelName, is_private: false })
    );
  } catch (error: any) {
    // Slack returns specific error codes - show them to user
    const errorCode = error?.data?.error || error?.message || 'unknown_error';
    const errorMessages: Record<string, string> = {
      name_taken: `Channel "${channelName}" already exists`,
      invalid_name_specials: 'Use only lowercase letters, numbers, hyphens, underscores',
      invalid_name_maxlength: 'Channel name must be 80 characters or less',
      invalid_name: 'Invalid channel name',
    };
    return { success: false, error: errorMessages[errorCode] || errorCode };
  }

  if (!createResult.ok) {
    const errorCode = createResult.error || 'unknown_error';
    const errorMessages: Record<string, string> = {
      name_taken: `Channel "${channelName}" already exists`,
      invalid_name_specials: 'Use only lowercase letters, numbers, hyphens, underscores',
      invalid_name_maxlength: 'Channel name must be 80 characters or less',
      invalid_name: 'Invalid channel name',
    };
    return { success: false, error: errorMessages[errorCode] || errorCode };
  }

  const newChannelId = createResult.channel.id;
  const actualName = createResult.channel.name;

  // 3. Invite user to the new channel (bot is auto-added, user is not)
  try {
    await withSlackRetry(() =>
      client.conversations.invite({
        channel: newChannelId,
        users: userId,
      })
    );
  } catch (error: any) {
    // If invite fails, log but continue - channel exists, user can join manually
    console.error('[ForkToChannel] Failed to invite user to channel:', error?.data?.error || error);
  }

  // 4. Fork SDK session with null prompt (uses synthetic message, like CLI --fork-session)
  // Use retry logic to handle transient SDK errors
  let forkedSessionId: string | null = null;
  try {
    forkedSessionId = await withRetry(
      async () => {
        const forkQuery = startClaudeQuery(null, {
          sessionId: forkPoint.sessionId,
          forkSession: true,
          resumeSessionAt: forkPoint.messageId,
          workingDir: getSession(sourceChannelId)?.workingDir ?? process.cwd(),
        });

        for await (const event of forkQuery) {
          if (event.type === 'system' && (event as any).subtype === 'init') {
            return (event as any).session_id as string;
          }
        }
        throw new Error('No session ID received from fork');
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        shouldRetry: () => true,  // Always retry SDK process errors
        onRetry: (err, attempt, delay) => {
          console.log(`[ForkToChannel] Fork attempt ${attempt} failed, retrying in ${delay}ms:`, err);
        },
      }
    );
  } catch (err) {
    console.error('[ForkToChannel] SDK fork failed after retries:', err);
    return { success: false, error: 'Failed to fork session' };
  }

  // 4. Get permalink to source message
  const forkLink = await getMessagePermalink(client, sourceChannelId, sourceMessageTs);

  // 5. Post first message in new channel with sessionId
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: newChannelId,
      text: `🔀 This is a fork of ${forkLink}`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔀 Point-in-time fork from <${forkLink}|this message>\n\nSession: \`${forkedSessionId}\``,
        },
      }],
    })
  );

  // 6. Create session for new channel with sessionId already populated
  const mainSession = getSession(sourceChannelId);
  await saveSession(newChannelId, {
    sessionId: forkedSessionId,  // Already have it!
    workingDir: mainSession?.workingDir ?? process.cwd(),
    mode: mainSession?.mode ?? 'default',
    model: mainSession?.model,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: mainSession?.pathConfigured ?? false,
    configuredPath: mainSession?.configuredPath ?? null,
    configuredBy: mainSession?.configuredBy ?? null,
    configuredAt: mainSession?.configuredAt ?? null,
    maxThinkingTokens: mainSession?.maxThinkingTokens,
    updateRateSeconds: mainSession?.updateRateSeconds,
    threadCharLimit: mainSession?.threadCharLimit,
    stripEmptyTag: mainSession?.stripEmptyTag,
    // Fork tracking (for restoring Fork here button if this channel is deleted)
    forkedFromChannelId: sourceChannelId,
    forkedFromMessageTs: sourceMessageTs,
    forkedFromThreadTs: threadTs,
    forkedFromSdkMessageId: params.sdkMessageId,
    forkedFromSessionId: params.sessionId,
    forkedFromConversationKey: params.conversationKey,
  });

  // 7. Update source message - replace "Fork here" with channel link + Refresh fork button
  await updateSourceMessageWithJumpLink(client, sourceChannelId, sourceMessageTs, newChannelId, actualName, {
    threadTs,
    sdkMessageId: params.sdkMessageId,
    sessionId: params.sessionId,
    conversationKey: params.conversationKey,
  });

  return { success: true, newChannelId };
}

// Update source message: replace "Fork here" button with fork link + "Refresh fork" button
// Uses mutex to prevent race condition if multiple forks happen simultaneously
async function updateSourceMessageWithJumpLink(
  client: any,
  channelId: string,
  messageTs: string,
  forkChannelId: string,
  forkChannelName: string,
  forkInfo: {
    threadTs?: string;
    sdkMessageId?: string;
    sessionId?: string;
    conversationKey?: string;
  }
): Promise<void> {
  // Use mutex to prevent race condition if multiple forks happen simultaneously
  const mutexKey = `${channelId}_${messageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    const historyResult = await withSlackRetry(() =>
      client.conversations.history({
        channel: channelId,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      })
    ) as { messages?: any[] };

    const msg = historyResult.messages?.[0];
    if (!msg?.blocks) return;

    const updatedBlocks: any[] = [];
    for (const block of msg.blocks) {
      if (block.type === 'actions') {
        // Filter out fork_here button, keep any remaining buttons
        const remainingElements = block.elements.filter(
          (el: any) => !el.action_id?.startsWith('fork_here_')
        );
        // Add context block with channel mention link BEFORE actions
        // Channel mention <#ID|name> navigates within Slack app (no browser)
        updatedBlocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `↗️ Fork: <#${forkChannelId}|${forkChannelName}>`,
          }],
        });
        // Add "Refresh fork" button to restore Fork here if forked channel is deleted
        const refreshForkButton = {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Refresh fork', emoji: true },
          action_id: `refresh_fork_${forkInfo.conversationKey || channelId}`,
          value: JSON.stringify({
            forkChannelId,
            threadTs: forkInfo.threadTs,
            sdkMessageId: forkInfo.sdkMessageId,
            sessionId: forkInfo.sessionId,
            conversationKey: forkInfo.conversationKey,
          }),
        };
        remainingElements.push(refreshForkButton);
        updatedBlocks.push({ ...block, elements: remainingElements });
      } else {
        updatedBlocks.push(block);
      }
    }

    await withSlackRetry(() =>
      client.chat.update({ channel: channelId, ts: messageTs, blocks: updatedBlocks, text: msg.text })
    );
  });
}

// Restore Fork here button when a forked channel is deleted
// Replaces the "Fork: #deleted-channel" context block with a Fork here button
async function restoreForkHereButton(
  client: any,
  forkInfo: {
    sourceChannelId: string;
    sourceMessageTs: string;
    threadTs?: string;
    sdkMessageId?: string;
    sessionId?: string;
    conversationKey?: string;
  }
): Promise<void> {
  const { sourceChannelId, sourceMessageTs, threadTs, sdkMessageId, sessionId, conversationKey } = forkInfo;

  // Can't restore button without fork point info
  if (!sdkMessageId || !sessionId || !conversationKey) {
    console.log('[RestoreForkHere] Missing fork point info, cannot restore button');
    return;
  }

  // Use mutex to prevent race condition
  const mutexKey = `${sourceChannelId}_${sourceMessageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    const historyResult = await withSlackRetry(() =>
      client.conversations.history({
        channel: sourceChannelId,
        latest: sourceMessageTs,
        inclusive: true,
        limit: 1,
      })
    ) as { messages?: any[] };

    const msg = historyResult.messages?.[0];
    if (!msg?.blocks) return;

    // Find and remove fork context block, filter refresh_fork from actions
    const updatedBlocks: any[] = [];
    let actionsBlockIndex = -1;

    for (let i = 0; i < msg.blocks.length; i++) {
      const block = msg.blocks[i];

      // Skip fork context blocks (they contain "Fork:" text)
      if (block.type === 'context' &&
          block.elements?.[0]?.text?.includes('Fork:')) {
        continue;
      }

      // Filter out refresh_fork button from actions block
      if (block.type === 'actions') {
        actionsBlockIndex = updatedBlocks.length;
        const filteredElements = block.elements.filter(
          (el: any) => !el.action_id?.startsWith('refresh_fork_')
        );
        updatedBlocks.push({ ...block, elements: filteredElements });
        continue;
      }

      updatedBlocks.push(block);
    }

    // Create Fork here button
    const forkHereButton = {
      type: 'button',
      text: { type: 'plain_text', text: ':twisted_rightwards_arrows: Fork here', emoji: true },
      action_id: `fork_here_${conversationKey}`,
      value: JSON.stringify({ threadTs, sdkMessageId, sessionId }),
    };

    // Add button to existing actions block, or create new one
    if (actionsBlockIndex >= 0) {
      updatedBlocks[actionsBlockIndex].elements.push(forkHereButton);
    } else {
      // No actions block - add one at the end
      updatedBlocks.push({
        type: 'actions',
        elements: [forkHereButton],
      });
    }

    await withSlackRetry(() =>
      client.chat.update({ channel: sourceChannelId, ts: sourceMessageTs, blocks: updatedBlocks, text: msg.text })
    );
  });
}

// Start reminder interval for tool approval (matches MCP ask_user behavior)
function startToolApprovalReminder(
  approvalId: string,
  toolName: string,
  channelId: string,
  client: any,
  threadTs?: string
): void {
  const startTime = Date.now();
  toolApprovalReminderStartTimes.set(approvalId, startTime);
  toolApprovalReminderCounts.set(approvalId, 0);

  const interval = setInterval(async () => {
    const count = toolApprovalReminderCounts.get(approvalId) || 0;

    // Check if expired (after 7 days / 42 reminders)
    if (count >= TOOL_APPROVAL_MAX_REMINDERS) {
      console.log(`Tool approval expired after 7 days: ${toolName} (${approvalId})`);
      clearToolApprovalReminder(approvalId);

      // Auto-deny after expiry
      const pending = pendingToolApprovals.get(approvalId);
      if (pending) {
        pendingToolApprovals.delete(approvalId);

        // Update the original message
        try {
          await client.chat.update({
            channel: pending.channelId,
            ts: pending.messageTs,
            text: `⏰ Expired: \`${pending.toolName}\` (no response after 7 days)`,
            blocks: [],
          });
        } catch (error) {
          console.error('Error updating expired tool approval message:', error);
        }

        pending.resolve({ behavior: 'deny', message: 'Tool approval expired after 7 days. Please retry.' });
      }
      return;
    }

    // Calculate remaining time
    const elapsedMs = Date.now() - startTime;
    const remainingMs = TOOL_APPROVAL_EXPIRY_MS - elapsedMs;
    const expiresIn = formatTimeRemaining(remainingMs);

    console.log(`Tool approval reminder ${count + 1} for ${approvalId} (expires in ${expiresIn})`);

    // Post reminder message
    const pending = pendingToolApprovals.get(approvalId);
    if (pending) {
      try {
        await withSlackRetry(() =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `⏰ *Reminder:* Still waiting for approval of \`${toolName}\`\nExpires in ${expiresIn}`,
          })
        );
      } catch (error) {
        console.error('Error posting tool approval reminder:', error);
      }
    }

    toolApprovalReminderCounts.set(approvalId, count + 1);
  }, TOOL_APPROVAL_REMINDER_INTERVAL_MS);

  toolApprovalReminderIntervals.set(approvalId, interval);
}

// Clear reminder interval for tool approval
function clearToolApprovalReminder(approvalId: string): void {
  const interval = toolApprovalReminderIntervals.get(approvalId);
  if (interval) {
    clearInterval(interval);
    toolApprovalReminderIntervals.delete(approvalId);
  }
  toolApprovalReminderCounts.delete(approvalId);
  toolApprovalReminderStartTimes.delete(approvalId);
}

// SDK AskUserQuestion type (matches SDK schema)
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  answers?: Record<string, string>;
  metadata?: { source?: string };
}

// Wait for user answer to SDK question
function waitForSdkQuestionAnswer(
  questionId: string,
  messageTs: string,
  channelId: string,
  threadTs: string | undefined,
  question: string,
  client: any
): Promise<string> {
  return new Promise((resolve) => {
    pendingSdkQuestions.set(questionId, {
      resolve,
      messageTs,
      channelId,
      threadTs,
      question,
    });
    // Start reminder (reuses tool approval reminder pattern)
    startToolApprovalReminder(questionId, 'AskUserQuestion', channelId, client, threadTs);
  });
}

// Handle SDK AskUserQuestion tool - works in ALL modes for CLI fidelity
async function handleAskUserQuestion(
  toolInput: Record<string, unknown>,
  channelId: string,
  threadTs: string | undefined,
  client: any,
  getAccumulatedResponse: () => string,
  clearAccumulatedResponse: () => void,
  isStillStreaming: () => boolean,
  conversationKey: string
): Promise<PermissionResult> {
  const input = toolInput as unknown as AskUserQuestionInput;
  const answers: Record<string, string> = {};

  console.log(`AskUserQuestion received with ${input.questions.length} question(s)`);

  // Post accumulated response BEFORE showing question (only if still actively streaming)
  // This ensures any explanation Claude generated is visible before the question
  const accumulatedContent = getAccumulatedResponse();
  if (isStillStreaming() && accumulatedContent.trim()) {
    console.log(`Posting accumulated response (${accumulatedContent.length} chars) before AskUserQuestion`);

    const strippedResponse = stripMarkdownCodeFence(accumulatedContent);
    const slackResponse = markdownToSlack(strippedResponse);

    const liveConfig = getLiveSessionConfig(channelId, threadTs);
    await uploadMarkdownAndPngWithResponse(
      client,
      channelId,
      strippedResponse,
      slackResponse,
      threadTs,
      undefined,  // userId
      liveConfig.threadCharLimit,
      liveConfig.stripEmptyTag
      // Note: Fork button now on activity message, not response
    );

    // Clear accumulated response so it's not posted again at the end
    clearAccumulatedResponse();
  }

  // Process each question sequentially
  for (const q of input.questions) {
    const questionId = `askuserq_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Build Slack blocks with SDK format (options have label+description)
    const blocks = buildSdkQuestionBlocks({
      question: q.question,
      header: q.header,
      options: q.options,
      questionId,
      multiSelect: q.multiSelect,
    });

    // Post to Slack
    const result = await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks,
        text: `[${q.header}] ${q.question}`,
      })
    );

    // Wait for user answer
    const answer = await waitForSdkQuestionAnswer(
      questionId,
      (result as { ts?: string }).ts!,
      channelId,
      threadTs,
      q.question,
      client
    );

    // Check for abort
    if (answer === '__ABORTED__') {
      console.log(`AskUserQuestion aborted by user`);
      return { behavior: 'deny', message: 'User aborted the question', interrupt: true };
    }

    answers[q.question] = answer;
    console.log(`AskUserQuestion answered: ${q.header} = ${answer}`);
  }

  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Handle @mentions in channels
app.event('app_mention', async ({ event, client }) => {
  try {
    // ONLY respond in channels (IDs start with 'C')
    // Reject DMs ('D'), group DMs ('G')
    if (!event.channel.startsWith('C')) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '❌ This bot only works in channels, not in direct messages.',
      });
      return;
    }

    // Reject @bot mentions in threads - only main channel allowed
    if (event.thread_ts) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '❌ @bot can only be mentioned in the main channel, not in threads.',
      });
      return;
    }

    // Remove the @mention from the text and normalize spaces
    const userText = event.text
      .replace(/<@[A-Z0-9]+>/g, '')
      .replace(/\s+/g, ' ')  // Normalize multiple spaces to single
      .trim();

    console.log(`Received mention from ${event.user}: ${userText}`);

    // Reject empty messages
    if (!userText) {
      await client.chat.postMessage({
        channel: event.channel,
        text: '❌ Empty messages are not permitted. Please include a message or command after @bot.',
      });
      return;
    }

    // Extract files from event (if any)
    const eventFiles = (event as any).files as SlackFile[] | undefined;

    await handleMessage({
      channelId: event.channel,
      userId: event.user,
      userText,
      originalTs: event.ts,
      threadTs: event.thread_ts, // Only set if already in a thread
      client,
      files: eventFiles,
    });
  } catch (error) {
    // NEVER let errors crash the bot - always report gracefully
    console.error('Error in app_mention handler:', error);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `❌ ${toUserMessage(error)}`,
      });
    } catch (e) {
      console.error('Failed to post error message:', e);
    }
  }
});

// Handle DM messages
app.message(async ({ message, client }) => {
  try {
    // Only respond to DMs with text (not bot messages or subtypes)
    if (message.channel_type !== 'im' || !('text' in message) || message.subtype !== undefined) {
      return;
    }

    // Ignore messages from the bot itself
    if ('bot_id' in message) {
      return;
    }

    const channelId = message.channel;
    const userText = message.text!;
    const userId = 'user' in message ? message.user : 'unknown';
    const messageTs = 'ts' in message ? message.ts : undefined;

    // Extract files from message (if any)
    const messageFiles = 'files' in message ? (message as any).files as SlackFile[] : undefined;

    console.log(`Received DM from ${userId}: ${userText}`);

    await handleMessage({
      channelId,
      userId,
      userText,
      originalTs: messageTs,
      client,
      files: messageFiles,
    });
  } catch (error) {
    // NEVER let errors crash the bot - always report gracefully
    console.error('Error in message handler:', error);
    try {
      if ('channel' in message) {
        await client.chat.postMessage({
          channel: message.channel,
          text: `❌ ${toUserMessage(error)}`,
        });
      }
    } catch (e) {
      console.error('Failed to post error message:', e);
    }
  }
});

/**
 * Handle channel deletion - clean up all sessions and SDK files
 *
 * When a channel is deleted:
 * 1. If this was a forked channel, restore Fork here button on source message
 * 2. Delete main session + all thread sessions from sessions.json
 * 3. Delete all corresponding SDK .jsonl files
 *
 * Terminal forks (created via --fork-session) are NOT deleted
 * as they may be user's personal sessions.
 */
app.event('channel_deleted', async ({ event }) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Channel deleted: ${event.channel}`);
    console.log(`${'='.repeat(60)}`);

    // Delete session (handles both bot records and SDK files)
    await deleteSession(event.channel);

    console.log(`${'='.repeat(60)}\n`);
  } catch (error) {
    console.error('Error handling channel deletion:', error);
    // Don't throw - cleanup failure shouldn't crash the bot
    // Log the error and continue running
  }
});

/**
 * Display plan approval UI (plan file + approval buttons)
 * Used by both normal completion and ExitPlanMode interrupt handling
 */
async function showPlanApprovalUI(params: {
  client: any;
  channelId: string;
  threadTs?: string;
  userId: string | undefined;
  conversationKey: string;
  planFilePath: string | null;
  exitPlanModeInput: ExitPlanModeInput | null;
  statusMsgTs?: string;
  processingState: {
    model?: string;
    toolsCompleted: number;
    startTime: number;
    activityLog: ActivityEntry[];
    // Stats for full status line:
    inputTokens?: number;
    outputTokens?: number;
    contextPercent?: number;
    compactPercent?: number;
    tokensToCompact?: number;
    costUsd?: number;
    durationMs?: number;
    rateLimitHits?: number;
    sessionId?: string;
  };
  session: { mode: PermissionMode };
  originalTs?: string;
}): Promise<void> {
  const {
    client, channelId, threadTs, userId, conversationKey,
    planFilePath, exitPlanModeInput, statusMsgTs, processingState,
    session, originalTs
  } = params;

  // Check abort status first
  if (isAborted(conversationKey)) {
    console.log('[PlanApproval] Skipping - query was aborted');
    return;
  }

  // Add activity log entry for ExitPlanMode completion
  processingState.activityLog.push({
    timestamp: Date.now(),
    type: 'tool_complete',
    tool: 'ExitPlanMode',
  });

  // Update status panel to complete
  if (statusMsgTs) {
    try {
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: statusMsgTs,
          blocks: buildCombinedStatusBlocks({
            activityLog: processingState.activityLog,
            inProgress: false,
            status: 'complete',
            mode: session.mode,
            model: processingState.model,
            toolsCompleted: processingState.toolsCompleted,
            elapsedMs: processingState.durationMs ?? (Date.now() - processingState.startTime),
            conversationKey,
            // Full stats (undefined fields are gracefully omitted by buildUnifiedStatusLine):
            inputTokens: processingState.inputTokens,
            outputTokens: processingState.outputTokens,
            contextPercent: processingState.contextPercent,
            compactPercent: processingState.compactPercent,
            tokensToCompact: processingState.tokensToCompact,
            costUsd: processingState.costUsd,
            rateLimitHits: processingState.rateLimitHits,
            sessionId: processingState.sessionId,
          }),
          text: 'Plan ready for review',
        })
      );
    } catch (e) {
      console.error('[PlanApproval] Error updating status panel:', e);
    }
  }

  // Display plan file content if available
  if (planFilePath) {
    try {
      const planContent = await fs.promises.readFile(planFilePath, 'utf-8');
      const slackFormatted = markdownToSlack(planContent);
      const liveConfig = getLiveSessionConfig(channelId, threadTs);

      await uploadMarkdownAndPngWithResponse(
        client,
        channelId,
        planContent,
        slackFormatted,
        threadTs,
        userId,
        liveConfig.threadCharLimit,
        liveConfig.stripEmptyTag
        // Note: Fork button now on activity message, not response
      );
    } catch (e) {
      console.error('[PlanApproval] Failed to read/display plan file:', e);
      // Show warning to user
      await withSlackRetry(async () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: ':warning: Could not read plan file. It may have been deleted or moved.',
        })
      );
    }
  } else {
    // No plan file path detected - show warning
    console.warn('[PlanApproval] No plan file path available');
    await withSlackRetry(async () =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: ':warning: Could not locate plan file. The plan may have been created in a previous session.',
      })
    );
  }

  // Show approval buttons
  try {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildPlanApprovalBlocks({
          conversationKey,
          allowedPrompts: exitPlanModeInput?.allowedPrompts,
        }),
        text: 'Would you like to proceed? Choose how to execute the plan.',
      })
    );
  } catch (btnError) {
    console.error('[PlanApproval] Error posting plan approval buttons:', btnError);
  }

  // Store pending plan approval (keeps busy state and :eyes:)
  if (originalTs) {
    pendingPlanApprovals.set(conversationKey, {
      originalTs,
      channelId,
      threadTs,
      statusMsgTs,                              // Reuse status message after approval
      activityLog: [...processingState.activityLog], // Snapshot current log for continuation
    });
  }
}

// Common message handler
async function handleMessage(params: {
  channelId: string;
  userId: string | undefined;
  userText: string;
  originalTs?: string;
  threadTs?: string;
  client: any;
  skipConcurrentCheck?: boolean;
  files?: SlackFile[];
  statusMsgTs?: string;           // Existing status message to reuse (for plan approval continuation)
  activityLog?: ActivityEntry[];  // Activity log to continue from (for plan approval continuation)
}) {
  const { channelId, userId, userText, originalTs, threadTs, client, skipConcurrentCheck, files, statusMsgTs: existingStatusMsgTs, activityLog: existingActivityLog } = params;

  // Always respond in threads - use originalTs as thread parent when in main channel
  const effectiveThreadTs = threadTs || originalTs;

  const conversationKey = getConversationKey(channelId, threadTs);
  // Activity log key must be unique per message (not per conversation)
  // For threads: threadTs is unique; for main channel: use originalTs
  const activityLogKey = threadTs ? `${channelId}_${threadTs}` : `${channelId}_${originalTs}`;

  // Block messages and most commands while terminal watcher is active
  // Only certain read-only/config commands are allowed during watching
  const ALLOWED_COMMANDS_WHILE_WATCHING = [
    'stop-watching', 'status', 'context', 'help',
    'update-rate', 'message-size', 'max-thinking-tokens', 'strip-empty-tag', 'ls'
  ];

  if (isWatching(channelId, threadTs)) {
    const isCommand = userText.trim().startsWith('/');
    const commandName = isCommand ? userText.trim().slice(1).split(/\s+/)[0].toLowerCase() : null;
    const isAllowedCommand = commandName && ALLOWED_COMMANDS_WHILE_WATCHING.includes(commandName);

    if (!isAllowedCommand) {
      // Block this message/command - user must /stop-watching first
      console.log(`[TerminalWatcher] Blocked message while watching: ${conversationKey}`);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        text: ':warning: Cannot run this while watching terminal.\nUse `/stop-watching` first, or click the *Stop Watching* button.',
      });
      return;
    }
  }

  // Get or create session (handle threads differently)
  let session: {
    sessionId: string | null;
    workingDir: string;
    mode: PermissionMode;
    model?: string;
    createdAt: number;
    lastActiveAt: number;
    pathConfigured: boolean;
    configuredPath: string | null;
    configuredBy: string | null;
    configuredAt: number | null;
    lastUsage?: LastUsage;
    maxThinkingTokens?: number;  // Extended thinking budget
    updateRateSeconds?: number;  // Status update interval (1-10s)
    threadCharLimit?: number;    // Thread char limit (100-3000, default 500)
    planFilePath?: string | null;  // Persistent plan file path for plan mode
  };
  let isNewFork = false;
  let forkedFromSessionId: string | null = null;

  // Track resumeSessionAt for point-in-time forking
  let resumeSessionAtMessageId: string | undefined;

  if (threadTs) {
    // Thread message - find fork point for point-in-time forking
    // Returns both messageId AND sessionId (for forking from correct session after /clear)
    const forkPoint = findForkPointMessageId(channelId, threadTs);
    if (forkPoint) {
      console.log(`[Fork] Thread will fork from message ${forkPoint.messageId} in session ${forkPoint.sessionId}`);
      resumeSessionAtMessageId = forkPoint.messageId;
    } else {
      console.warn(`[Fork] No message mapping found for ${threadTs} - will fork from latest state`);
    }

    // Thread message - use or create forked session
    // Pass forkPoint so getOrCreateThreadSession uses the CORRECT session (from the message)
    // not the current main session (which may be null after /clear)
    const threadResult = await getOrCreateThreadSession(channelId, threadTs, forkPoint);
    session = {
      sessionId: threadResult.session.sessionId,
      workingDir: threadResult.session.workingDir,
      mode: threadResult.session.mode,
      model: threadResult.session.model,
      createdAt: threadResult.session.createdAt,
      lastActiveAt: threadResult.session.lastActiveAt,
      pathConfigured: threadResult.session.pathConfigured,
      configuredPath: threadResult.session.configuredPath,
      configuredBy: threadResult.session.configuredBy,
      configuredAt: threadResult.session.configuredAt,
      lastUsage: threadResult.session.lastUsage,
      maxThinkingTokens: threadResult.session.maxThinkingTokens,
      updateRateSeconds: threadResult.session.updateRateSeconds,
      threadCharLimit: threadResult.session.threadCharLimit,
      planFilePath: threadResult.session.planFilePath,
    };
    isNewFork = threadResult.isNewFork;
    forkedFromSessionId = threadResult.session.forkedFrom;
    // Use stored resumeSessionAtMessageId if this is an existing session
    if (!isNewFork && threadResult.session.resumeSessionAtMessageId) {
      resumeSessionAtMessageId = threadResult.session.resumeSessionAtMessageId;
    }

    if (isNewFork) {
      // Build link to the fork point - the message user replied to (threadTs)
      // With point-in-time forking, we fork from this specific message, not the last one
      // Use Slack API to get workspace-specific permalink (works on iOS mobile)
      const forkPointLink = await getMessagePermalink(client, channelId, threadTs);
      const forkMessage = `🔀 _Forked with conversation state through: <${forkPointLink}|this message>_`;

      // Notify user about fork with link to actual fork point
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          text: forkMessage,
        })
      );
    }
  } else {
    // Main DM - use main session
    let mainSession = getSession(channelId);
    if (!mainSession) {
      mainSession = {
        sessionId: null,
        workingDir: process.cwd(),
        mode: 'plan',
        model: undefined,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
        planFilePath: null,
      };
      await saveSession(channelId, mainSession);
    }
    session = mainSession;
  }

  // Add eyes reaction immediately to show we received the message
  if (originalTs) {
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch (error) {
      // Ignore errors (e.g., already reacted)
    }
  }

  // Extract inline /mode command (e.g., "@bot /mode plan do something")
  const inlineModeResult = extractInlineMode(userText);

  if (inlineModeResult.error) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        text: inlineModeResult.error,
      })
    );
    if (originalTs) {
      try {
        await client.reactions.remove({ channel: channelId, timestamp: originalTs, name: 'eyes' });
      } catch { /* ignore */ }
    }
    return;
  }

  // Track inline mode change for activity log
  let inlineModeChanged: string | undefined;

  if (inlineModeResult.mode) {
    // Save mode change (thread-aware)
    if (threadTs) {
      await saveThreadSession(channelId, threadTs, { mode: inlineModeResult.mode });
    } else {
      await saveSession(channelId, { mode: inlineModeResult.mode });
    }
    session.mode = inlineModeResult.mode;
    inlineModeChanged = inlineModeResult.mode;  // Track for activity log
    console.log(`[InlineMode] Mode switched to ${inlineModeResult.mode}`);

    // If no remaining text, just confirm mode change
    if (!inlineModeResult.remainingText) {
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          text: `Mode set to \`${inlineModeResult.mode}\``,
        })
      );
      if (originalTs) {
        try {
          await client.reactions.remove({ channel: channelId, timestamp: originalTs, name: 'eyes' });
        } catch { /* ignore */ }
      }
      return;
    }
  }

  // Use remaining text for command parsing
  const textToProcess = inlineModeResult.remainingText;

  // Check for slash commands (e.g., /status, /mode, /continue)
  const commandResult = parseCommand(textToProcess, session, threadTs);

  // Handle /wait command (rate limit stress test)
  if (commandResult.waitTest) {
    await runWaitTest(
      client,
      channelId,
      threadTs,
      commandResult.waitTest.seconds,
      session.mode,
      originalTs
    );
    return;
  }

  // Handle /model command (async model fetch)
  if (commandResult.showModelSelection) {
    const models = await getAvailableModels();
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        blocks: buildModelSelectionBlocks(models, session.model),
        text: 'Select model',
      })
    );

    // Remove eyes reaction
    if (originalTs) {
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: originalTs,
          name: 'eyes',
        });
      } catch {
        // Ignore errors
      }
    }
    return;
  }

  // Handle /compact command (session compaction)
  if (commandResult.compactSession) {
    if (await checkBusyAndRespond(client, channelId, effectiveThreadTs, conversationKey, originalTs)) {
      return;
    }
    await runCompactSession(
      client,
      channelId,
      effectiveThreadTs,
      session,
      originalTs,
      conversationKey
    );
    return;
  }

  // Handle /clear command (clear session history)
  if (commandResult.clearSession) {
    if (await checkBusyAndRespond(client, channelId, effectiveThreadTs, conversationKey, originalTs)) {
      return;
    }
    await runClearSession(
      client,
      channelId,
      effectiveThreadTs,  // Where to post messages
      threadTs,           // Original thread context for session management
      session,
      originalTs
    );
    return;
  }

  if (commandResult.handled) {
    // Apply any session updates from the command
    // Use updated mode if command changed it, otherwise use current mode
    const displayMode = commandResult.sessionUpdate?.mode || session.mode;
    if (commandResult.sessionUpdate) {
      // Add userId for /path command
      if (commandResult.sessionUpdate.pathConfigured) {
        commandResult.sessionUpdate.configuredBy = userId ?? null;
      }
      // Save to correct session based on context (thread vs main channel)
      if (threadTs) {
        await saveThreadSession(channelId, threadTs, commandResult.sessionUpdate);
      } else {
        await saveSession(channelId, commandResult.sessionUpdate);
      }

      // Live update: If a query is running, update its processingState and SDK settings immediately
      // This allows config commands to take effect without waiting for next query
      const activeQuery = activeQueries.get(conversationKey);
      if (activeQuery) {
        // Live mode update via SDK
        if (commandResult.sessionUpdate.mode !== undefined) {
          try {
            await activeQuery.query.setPermissionMode(commandResult.sessionUpdate.mode);
            activeQuery.mode = commandResult.sessionUpdate.mode;
            console.log(`[LiveConfig] Updated active query mode to ${commandResult.sessionUpdate.mode}`);
          } catch (err) {
            console.error('[LiveConfig] Failed to update mode:', err);
          }
        }

        // NOTE: Model changes (setModel) don't take effect mid-turn - they only apply
        // to subsequent turns. Model selection is blocked while busy to avoid confusion.

        // Live thinking tokens update via SDK
        if (commandResult.sessionUpdate.maxThinkingTokens !== undefined) {
          try {
            // SDK expects null to clear limit, but 0 means disabled
            // Pass 0 as 0 (which the SDK may treat as "no thinking")
            // Pass undefined would mean "default", but we store explicit values
            const tokens = commandResult.sessionUpdate.maxThinkingTokens === 0
              ? null  // 0 means disabled → pass null to SDK to use default (then thinking happens but no extended budget)
              : commandResult.sessionUpdate.maxThinkingTokens;
            await activeQuery.query.setMaxThinkingTokens(tokens);
            console.log(`[LiveConfig] Updated active query maxThinkingTokens to ${tokens}`);
          } catch (err) {
            console.error('[LiveConfig] Failed to update maxThinkingTokens:', err);
          }
        }

        // updateRateSeconds - update ProcessingState directly
        if (commandResult.sessionUpdate.updateRateSeconds !== undefined) {
          activeQuery.processingState.updateRateSeconds = commandResult.sessionUpdate.updateRateSeconds;
          console.log(`[LiveConfig] Updated active query updateRateSeconds to ${commandResult.sessionUpdate.updateRateSeconds}`);
        }
      }
    }

    // Update terminal watcher rate if active
    if (commandResult.sessionUpdate?.updateRateSeconds !== undefined && isWatching(channelId, threadTs)) {
      updateWatchRate(channelId, threadTs, commandResult.sessionUpdate.updateRateSeconds);
    }

    // NOTE: No mode header for commands - header is only posted for Claude queries
    // Commands handle their own output (response text, blocks, or special handlers)

    // Check if busy BEFORE posting /watch response - must block before anchor is posted
    if (commandResult.startTerminalWatch && session?.sessionId) {
      if (await checkBusyAndRespond(client, channelId, effectiveThreadTs, conversationKey, originalTs)) {
        return;
      }
    }

    // Post command response
    if (commandResult.blocks) {
      // For /watch command: anchor posted to main channel (no thread_ts)
      // Activity will post as thread replies to the anchor
      const postToThread = commandResult.startTerminalWatch ? undefined : effectiveThreadTs;
      const response = await client.chat.postMessage({
        channel: channelId,
        thread_ts: postToThread,
        blocks: commandResult.blocks,
        text: 'Command response',
      });

      // Start terminal watcher if requested (for /watch command)
      // Use response.ts as BOTH the status message ts AND the threadTs for activity
      // This makes all terminal activity post as thread replies to the anchor
      if (commandResult.startTerminalWatch && session?.sessionId && response.ts) {
        const anchorTs = response.ts as string;

        // Mark conversation as busy to block queries during /watch setup
        // This will remain set while watching - removed when stopWatching is called
        busyConversations.add(conversationKey);

        // Update the anchor with correct blocks that include anchorTs for stop button
        // This is needed because commands.ts doesn't know anchorTs when building blocks
        const updateRate = session.updateRateSeconds ?? UPDATE_RATE_DEFAULT;
        const terminalCommand = `cd ${session.workingDir} && claude --dangerously-skip-permissions --resume ${session.sessionId}`;
        await client.chat.update({
          channel: channelId,
          ts: anchorTs,
          text: 'Terminal Watch',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: 'Continue in Terminal' },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Run this command to continue your session locally:' },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '```' + terminalCommand + '```' },
            },
            {
              type: 'divider',
            },
            buildWatchingStatusSection(session.sessionId, updateRate, anchorTs),
          ],
        });

        const result = startWatching(channelId, anchorTs, session, client, anchorTs, userId);
        if (!result.success) {
          // Notify user of error - post as thread reply to anchor
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: anchorTs,
            text: `:warning: Could not start watching: ${result.error}`,
          });
          // Remove from busy state since watcher failed to start
          busyConversations.delete(conversationKey);
        }
      }

    } else if (commandResult.stopTerminalWatch) {
      // Stop terminal watcher (for /stop-watching command)
      const stopped = stopWatching(channelId, threadTs);
      // Remove from busy state when watcher stops
      // Always use channelId only since /watch is main-channel-only
      busyConversations.delete(channelId);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        text: stopped
          ? ':white_check_mark: Stopped watching terminal session.'
          : ':information_source: No active terminal watcher in this conversation.',
      });
    } else if (commandResult.fastForward && session?.sessionId) {
      // Check if busy - /ff should be blocked like agent queries
      if (await checkBusyAndRespond(client, channelId, effectiveThreadTs, conversationKey, originalTs)) {
        return;
      }
      // Fast-forward: sync missed terminal messages and start watching
      await handleFastForwardSync(client, channelId, effectiveThreadTs, session, userId);
    } else if (commandResult.showPlan && commandResult.planFilePath) {
      // /show-plan command: post plan file content to thread
      try {
        const planContent = await fs.promises.readFile(commandResult.planFilePath, 'utf-8');
        const slackFormatted = markdownToSlack(planContent);
        const liveConfig = getLiveSessionConfig(channelId, threadTs);
        const headerText = `:clipboard: *Current Plan*\n\`${commandResult.planFilePath}\``;
        await uploadMarkdownAndPngWithResponse(
          client,
          channelId,
          planContent,
          `${headerText}\n\n${slackFormatted}`,
          effectiveThreadTs,
          userId,
          liveConfig.threadCharLimit,
          liveConfig.stripEmptyTag
        );
      } catch (e) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          text: `❌ Plan file not found at \`${commandResult.planFilePath}\``,
        });
      }
    } else if (commandResult.response) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        text: commandResult.response,
      });
    }

    // Remove eyes reaction - command done
    if (originalTs) {
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: originalTs,
          name: 'eyes',
        });
      } catch (error) {
        // Ignore errors
      }
    }

    return; // Command handled, don't send to Claude
  }

  // GUARD: Path must be configured before processing messages
  if (!session.pathConfigured) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: effectiveThreadTs,
      blocks: buildPathSetupBlocks(),
      text: 'Please set working directory first: /path /your/project/path',
    });

    // Remove eyes reaction
    if (originalTs) {
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: originalTs,
          name: 'eyes',
        });
      } catch (error) {
        // Ignore
      }
    }

    return; // Don't process the message
  }

  // GUARD: Check if stored model is still available
  if (session.model) {
    const modelAvailable = await isModelAvailable(session.model);

    if (!modelAvailable) {
      // Stored model is deprecated/unavailable
      console.log(`Model ${session.model} is no longer available, prompting user to select new model`);
      const models = await getAvailableModels();

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        blocks: buildModelDeprecatedBlocks(session.model, models),
        text: 'Your selected model is no longer available. Please select a new model.',
      });

      // Clear invalid model from session (thread-aware)
      if (threadTs) {
        await saveThreadSession(channelId, threadTs, { model: undefined });
      } else {
        await saveSession(channelId, { model: undefined });
      }

      // Remove eyes reaction
      if (originalTs) {
        try {
          await client.reactions.remove({
            channel: channelId,
            timestamp: originalTs,
            name: 'eyes',
          });
        } catch {
          // Ignore
        }
      }

      return; // Don't proceed with query until user selects new model
    }
  }

  // Check for concurrent terminal session
  if (session.sessionId && !skipConcurrentCheck) {
    const concurrentCheck = await isSessionActiveInTerminal(session.sessionId, session.workingDir);
    if (concurrentCheck.active) {
      console.log(`Session ${session.sessionId} is active in terminal (PID: ${concurrentCheck.pid})`);

      // Store pending message for potential "proceed anyway"
      pendingMessages.set(`${channelId}_${session.sessionId}`, {
        channelId,
        userId,
        userText,
        originalTs,
        threadTs,
      });

      // Show warning with Cancel/Proceed buttons
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: effectiveThreadTs,
        blocks: buildConcurrentWarningBlocks(concurrentCheck.pid!, session.sessionId),
        text: `Warning: This session is currently active in your terminal (PID: ${concurrentCheck.pid})`,
      });
      return;
    }
  }

  // Capture user message timestamp for message mapping
  // This enables point-in-time thread forking by tracking which SDK messages
  // correspond to which Slack timestamps
  // NOTE: sessionId may be null here (new session or after /clear) - that's fine
  // because user messages are placeholders and we use assistant messages for forking
  if (originalTs && session.sessionId) {
    await saveMessageMapping(channelId, originalTs, {
      sdkMessageId: `user_${originalTs}`,  // Placeholder - user messages don't have SDK IDs
      sessionId: session.sessionId,
      type: 'user',
    });
    console.log(`[Mapping] Saved user message mapping for ${originalTs} in session ${session.sessionId}`);
  }

  // Check if conversation is busy before starting query
  if (await checkBusyAndRespond(client, channelId, effectiveThreadTs, conversationKey, originalTs)) {
    return;
  }

  // Mark conversation as busy
  busyConversations.add(conversationKey);

  // Initialize processing state for real-time activity tracking
  const startTime = Date.now();
  const processingState: ProcessingState = {
    status: 'starting',
    toolsCompleted: 0,
    thinkingBlockCount: 0,
    startTime,
    lastUpdateTime: 0,
    updateRateSeconds: session.updateRateSeconds ?? UPDATE_RATE_DEFAULT,
    // Continue from existing log (for plan approval continuation), or fresh start
    activityLog: existingActivityLog || [
      // Add starting entry so it persists in the log (not a fallback that disappears)
      { timestamp: startTime, type: 'starting' },
    ],
    currentThinkingIndex: null,
    currentThinkingContent: '',
    currentToolUseIndex: null,
    spinnerIndex: 0,
    rateLimitHits: 0,
    rateLimitNotified: false,
    exitPlanModeIndex: null,
    exitPlanModeInputJson: '',
    exitPlanModeInput: null,
    toolInputs: new Map(),
    toolUseIds: new Map(),
    // Initialize from session (falls back to null if not set)
    planFilePath: session.planFilePath || null,
    // Upload failure tracking for retry button
    uploadFailed: false,
    // Thread-based activity tracking
    activityThreadMsgTs: null,
    activityBatch: [],
    activityBatchStartIndex: 0,
    lastActivityPostTime: 0,
    threadParentTs: null,  // Will be set to statusMsgTs after posting
    charLimit: session.threadCharLimit ?? MESSAGE_SIZE_DEFAULT,
    postedBatchTs: null,
    postedBatchToolUseIds: new Set(),
    // Thinking update race condition protection
    pendingThinkingUpdate: null,
    // Compaction tracking (shared by /compact and auto-compact)
    compactMsgTs: null,
    compactStartTime: null,
    compactPreTokens: null,
    compactIsManual: false,  // auto-compact
  };

  // Add mode_changed entry if inline mode was used
  if (inlineModeChanged) {
    const modeEntry: ActivityEntry = {
      timestamp: Date.now(),
      type: 'mode_changed',
      mode: inlineModeChanged,
    };
    processingState.activityLog.push(modeEntry);
    processingState.activityBatch.push(modeEntry);
  }

  // Post single combined message (activity log + status panel)
  // Activity log at top, status panel with abort button at bottom
  let statusMsgTs: string | undefined = existingStatusMsgTs;

  if (statusMsgTs) {
    // REUSE existing status message - update it instead of creating new
    try {
      await withSlackRetry(async () =>
        client.chat.update({
          channel: channelId,
          ts: statusMsgTs,
          blocks: buildCombinedStatusBlocks({
            activityLog: processingState.activityLog,
            inProgress: true,
            status: 'starting',
            mode: session.mode,
            toolsCompleted: 0,
            elapsedMs: 0,
            conversationKey,
            spinner: SPINNER_FRAMES[0],  // Show spinner immediately
            sessionId: session.sessionId || undefined,
          }),
          text: 'Claude is continuing...',
        })
      );
      processingState.threadParentTs = statusMsgTs;
    } catch (error: any) {
      // Fallback if message deleted - warn user and create new at bottom
      if (error.data?.error === 'message_not_found') {
        console.warn('[StatusMessage] Original status message was deleted, creating new one');
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          text: ':warning: Original status message was deleted. Creating new status message below.',
        });
        statusMsgTs = undefined;  // Will create new below
      } else {
        throw error;
      }
    }
  }

  if (!statusMsgTs) {
    // CREATE new status message (original behavior)
    try {
      const combinedResult = await withSlackRetry(async () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          blocks: buildCombinedStatusBlocks({
            activityLog: processingState.activityLog,
            inProgress: true,
            status: 'starting',
            mode: session.mode,
            toolsCompleted: 0,
            elapsedMs: 0,
            conversationKey,
            spinner: SPINNER_FRAMES[0],  // Show spinner immediately
            sessionId: session.sessionId || undefined,  // Initial session ID (may be null for new sessions)
          }),
          text: 'Claude is starting...',
        })
      );
      statusMsgTs = (combinedResult as { ts?: string }).ts;
      // Set thread parent to status message for activity thread replies
      if (statusMsgTs) {
        processingState.threadParentTs = statusMsgTs;
      }
    } catch (error) {
      console.error('Error posting combined status message:', error);
      // Fallback: use original user message as thread parent if status fails
      processingState.threadParentTs = originalTs || null;
    }
  }

  // Post starting entry to thread (activity thread reply) - ONLY if NOT reusing status message
  if (processingState.threadParentTs && !existingStatusMsgTs) {
    postStartingToThread(client, channelId, processingState.threadParentTs).catch(err => {
      console.error('[Activity Thread] Failed to post starting entry:', err);
    });
  }

  // Spinner timer - declared outside try block so it can be cleaned up in finally
  let spinnerTimer: NodeJS.Timeout | undefined;

  // Stream Claude response to Slack with real-time updates
  try {
    // Create canUseTool callback - ALWAYS defined for AskUserQuestion support in all modes
    // For other tools, only prompts in 'default' mode (manual approval)
    // Uses 7-day timeout with 4-hour reminders (matches MCP ask_user behavior)
    const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, _options: { signal: AbortSignal }): Promise<PermissionResult> => {
      // Handle AskUserQuestion in ALL modes for CLI fidelity
      if (toolName === 'AskUserQuestion') {
        return handleAskUserQuestion(
          toolInput,
          channelId,
          effectiveThreadTs,
          client,
          () => currentResponse,           // Getter for current segment response
          () => { currentResponse = ''; },  // Clear current segment after posting
          () => isActivelyStreaming,        // Check if still in middle of streaming
          conversationKey
        );
      }

      // Auto-deny MCP approve_action tool - we handle approvals directly via canUseTool
      // Without this, we'd get double approval: canUseTool for approve_action, then MCP's own UI
      if (toolName === 'mcp__ask-user__approve_action') {
        console.log(`Auto-denying ${toolName} - approvals handled via canUseTool`);
        return { behavior: 'deny', message: 'Tool approvals are handled directly via Slack buttons, not via MCP approve_action.' };
      }

      // For non-AskUserQuestion tools, only prompt in 'default' mode
      if (session.mode !== 'default') {
        return { behavior: 'allow', updatedInput: toolInput };
      }

      // Post accumulated response BEFORE showing approval prompt (only if still actively streaming)
      // This ensures any explanation Claude generated is visible before the tool approval
      // Note: With interleaved approach, this posts the current segment before approval UI
      if (isActivelyStreaming && currentResponse.trim()) {
        console.log(`Posting current segment response (${currentResponse.length} chars) before tool approval`);

        const liveConfig = getLiveSessionConfig(channelId, threadTs);
        const strippedResponse = stripMarkdownCodeFence(currentResponse, {
          stripEmptyTag: liveConfig.stripEmptyTag,
        });
        const slackResponse = markdownToSlack(strippedResponse);

        await uploadMarkdownAndPngWithResponse(
          client,
          channelId,
          strippedResponse,
          slackResponse,
          effectiveThreadTs,
          undefined,  // userId
          liveConfig.threadCharLimit,
          liveConfig.stripEmptyTag
          // Note: Fork button now on activity message, not response
        );

        // Clear current segment so it's not posted again (fullResponse keeps total)
        currentResponse = '';
      }

      // Generate unique approval ID
      const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      console.log(`Tool approval requested: ${toolName} (${approvalId})`);

      // Post approval request to Slack with buttons
      const result = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: effectiveThreadTs,
          blocks: buildToolApprovalBlocks({ approvalId, toolName, toolInput }),
          text: `Claude wants to use ${toolName}. Approve?`,
        })
      );

      // Wait for user response (7-day timeout with 4-hour reminders)
      return new Promise((resolve) => {
        pendingToolApprovals.set(approvalId, {
          toolName,
          toolInput,
          resolve,
          messageTs: (result as { ts?: string }).ts!,
          channelId,
          threadTs: effectiveThreadTs,
        });

        // Start reminder interval (4 hours) with 7-day expiry
        startToolApprovalReminder(approvalId, toolName, channelId, client, effectiveThreadTs);
      });
    };

    // Process uploaded files (if any)
    let messageContent: string | ContentBlock[] = textToProcess;
    if (files && files.length > 0) {
      console.log(`[FileUpload] Processing ${files.length} file(s)`);
      try {
        const { files: processedFiles, warnings } = await processSlackFiles(
          files,
          process.env.SLACK_BOT_TOKEN!
        );
        messageContent = buildMessageContent(textToProcess, processedFiles, warnings);
        if (Array.isArray(messageContent)) {
          console.log(`[FileUpload] Built ${messageContent.length} content blocks`);
        }
      } catch (error) {
        console.error('[FileUpload] Error processing files:', error);
        // Continue with just the text if file processing fails
      }
    }

    // Start Claude query (returns Query object with interrupt() method)
    // For new thread forks, use forkSession flag with parent session ID
    // Also detect uninitialized forks created by /fork-thread (sessionId null but forkedFrom set)
    const needsFork = isNewFork || (session.sessionId === null && forkedFromSessionId !== null);
    // Determine thinking tokens: 0 = disabled, undefined = use default (31,999)
    const maxThinkingTokens = session.maxThinkingTokens === 0
      ? 0  // Disabled
      : (session.maxThinkingTokens ?? 31999);  // Use configured or default
    const claudeQuery = startClaudeQuery(messageContent, {
      sessionId: needsFork ? forkedFromSessionId ?? undefined : session.sessionId ?? undefined,
      workingDir: session.workingDir,
      mode: session.mode,
      model: session.model,  // Pass validated model (or undefined for SDK default)
      forkSession: needsFork,  // Fork when first message in thread or uninitialized fork
      resumeSessionAt: needsFork ? resumeSessionAtMessageId : undefined,  // Point-in-time forking
      canUseTool,  // For manual approval in default mode
      maxThinkingTokens,  // Extended thinking budget
      slackContext: {
        channel: channelId,
        threadTs: effectiveThreadTs,
        user: userId ?? 'unknown',
      },
    });

    // Track active query for abort capability
    if (statusMsgTs) {
      activeQueries.set(conversationKey, {
        query: claudeQuery,
        statusMsgTs,
        mode: session.mode,
        processingState,
      });
    }

    // Collect complete response from SDK (no streaming placeholder needed)
    // currentResponse: text for current segment (reset after each segment posts)
    // fullResponse: total accumulated text (for backwards compat and total char tracking)
    let currentResponse = '';
    let fullResponse = '';
    let isActivelyStreaming = true;  // Flag to track if we're in middle of streaming (before result)
    let newSessionId: string | null = null;
    let modelName: string | undefined;
    const assistantMessageUuids: Set<string> = new Set();  // Track ALL assistant UUIDs for message mapping
    let currentAssistantUuid: string | null = null;  // Current assistant UUID for immediate mapping (point-in-time forking)
    const mappedAssistantUuids: Set<string> = new Set();  // Track UUIDs that got immediate mapped (to skip placeholder)
    let costUsd: number | undefined;

    // Helper to start an in-progress thinking entry (for live streaming)
    // Flushes pending tool batch to thread before starting thinking
    const startThinkingEntry = async () => {
      // Flush pending tool entries to thread before thinking starts
      if (processingState.activityBatch.length > 0) {
        const liveConfig = getLiveSessionConfig(channelId, threadTs);
        await flushActivityBatch(
          processingState,
          client,
          channelId,
          liveConfig.threadCharLimit,
          'long_content',
          userId
        );
      }

      const elapsedMs = Date.now() - processingState.startTime;
      processingState.activityLog.push({
        timestamp: Date.now(),
        type: 'thinking',
        thinkingContent: '',
        thinkingTruncated: '',
        thinkingInProgress: true,
        durationMs: elapsedMs,
      });
      processingState.thinkingBlockCount++;
      processingState.status = 'thinking';

      // Post placeholder thinking message to thread (will be edited in-place)
      if (processingState.threadParentTs) {
        try {
          const result = await client.chat.postMessage({
            channel: channelId,
            thread_ts: processingState.threadParentTs,
            text: ':bulb: *Thinking...*',
            mrkdwn: true,
          });
          if (result.ts) {
            processingState.activityThreadMsgTs = result.ts as string;
            console.log(`[Activity Thread] Posted thinking placeholder: ${result.ts}`);
          }
        } catch (err) {
          console.error('[Activity Thread] Failed to post thinking placeholder:', err);
        }
      }

      console.log(`[Activity] Thinking block started (in-progress), total: ${processingState.activityLog.length} entries`);
    };

    // Helper to update the in-progress thinking entry with rolling window (last 500 chars)
    const updateThinkingEntry = (content: string) => {
      // Find the last in-progress thinking entry
      let elapsedSec = 0;
      for (let i = processingState.activityLog.length - 1; i >= 0; i--) {
        const entry = processingState.activityLog[i];
        if (entry.type === 'thinking' && entry.thinkingInProgress) {
          const elapsedMs = Date.now() - processingState.startTime;
          elapsedSec = Math.floor(elapsedMs / 1000);
          // Rolling window: show last 500 chars (what Claude is thinking NOW)
          const rollingWindow = content.length > THINKING_TRUNCATE_LENGTH
            ? '...' + content.substring(content.length - THINKING_TRUNCATE_LENGTH)
            : content;
          entry.thinkingContent = content;
          entry.thinkingTruncated = rollingWindow;
          entry.durationMs = elapsedMs;
          break;
        }
      }

      // Edit thread message in-place (fire-and-forget to avoid blocking)
      // Throttle to respect updateRateSeconds - timer will catch up anyway
      if (processingState.activityThreadMsgTs) {
        const now = Date.now();
        const intervalMs = processingState.updateRateSeconds * 1000;

        // Only update if enough time passed since last update
        if (now - processingState.lastUpdateTime >= intervalMs) {
          // Use rolling tail window for thread message during streaming
          const preview = content.length > THINKING_MESSAGE_SIZE
            ? extractTailWithFormatting(content, THINKING_MESSAGE_SIZE)
            : content;
          // Store promise so finalization can await it before delete
          processingState.pendingThinkingUpdate = client.chat.update({
            channel: channelId,
            ts: processingState.activityThreadMsgTs,
            text: `:bulb: *Thinking...* [${elapsedSec}s] _${content.length} chars_\n> ${preview}`,
          })
            .then(() => {})  // Convert to Promise<void>
            .catch((err: unknown) => {
              console.error('[Activity Thread] Failed to update thinking in-place:', err);
            })
            .finally(() => {
              processingState.pendingThinkingUpdate = null;
            });
          processingState.lastUpdateTime = now;
        }
        // Otherwise: skip - timer will sync status message anyway
      }
    };

    // Helper to finalize the in-progress thinking entry and post to thread
    // Uses smooth in-place update with cross-linked file attachment (no delete+repost)
    const finalizeThinkingEntry = async (content: string) => {
      // Find the last in-progress thinking entry and finalize it
      let finalEntry: ActivityEntry | null = null;
      let elapsedMs = 0;
      for (let i = processingState.activityLog.length - 1; i >= 0; i--) {
        const entry = processingState.activityLog[i];
        if (entry.type === 'thinking' && entry.thinkingInProgress) {
          elapsedMs = Date.now() - processingState.startTime;
          // For final state, store full content and last 500 chars for summary (shows conclusion)
          const truncated = content.length > THINKING_TRUNCATE_LENGTH
            ? '...' + content.substring(content.length - THINKING_TRUNCATE_LENGTH)
            : content;
          entry.thinkingContent = content;
          entry.thinkingTruncated = truncated;
          entry.thinkingInProgress = false;
          entry.durationMs = elapsedMs;
          finalEntry = entry;
          console.log(`[Activity] Thinking block finalized (${content.length} chars)`);
          break;
        }
      }

      // Update or post thinking to thread
      if (finalEntry && processingState.threadParentTs) {
        const charLimit = THINKING_MESSAGE_SIZE;
        const elapsedSec = Math.floor(elapsedMs / 1000);

        // If content exceeds limit, need to upload file and update message in-place
        if (content.length > charLimit && processingState.activityThreadMsgTs) {
          // Wait for any in-flight thinking update to complete
          if (processingState.pendingThinkingUpdate) {
            await processingState.pendingThinkingUpdate;
          }

          // Get permalink to thinking message (for file message back-link)
          const thinkingMsgLink = await getMessagePermalink(
            client, channelId, processingState.activityThreadMsgTs
          );

          // 1. Upload files FIRST with back-link to thinking message
          const uploadResult = await uploadFilesToThread(
            client,
            channelId,
            processingState.threadParentTs,
            content,
            `_Content for <${thinkingMsgLink}|this thinking block>._`,
            userId
          );

          if (uploadResult.success && uploadResult.fileMessageTs) {
            // 2. Get permalink to file message (for thinking message forward-link)
            const fileMsgLink = await getMessagePermalink(
              client, channelId, uploadResult.fileMessageTs
            );

            // 3. Format message with rolling tail + link to file
            const formattedText = formatThreadThinkingMessage(
              finalEntry,
              true,
              charLimit,
              { preserveTail: true, attachmentLink: fileMsgLink }
            );

            // 4. Update thinking message with retry (5 attempts)
            await updateThinkingMessageWithRetry(
              client, channelId, processingState.activityThreadMsgTs,
              formattedText, 5, channelId  // For error logging
            );
            console.log(`[Activity Thread] Thinking updated in-place with file link: ${uploadResult.fileMessageTs}`);
          } else {
            // Upload failed - show retry button (no suffix)
            const formattedText = formatThreadThinkingMessage(
              finalEntry, false, charLimit,
              { preserveTail: true }
            );

            const blocks = [
              { type: 'section' as const, text: { type: 'mrkdwn' as const, text: formattedText } },
              buildAttachThinkingFileButton(
                processingState.activityThreadMsgTs,
                processingState.threadParentTs,
                channelId,
                newSessionId || '',  // Session ID for retry lookup
                finalEntry.timestamp,    // Use timestamp for lookup
                content.length           // Use charCount for verification
              ),
            ];

            try {
              await client.chat.update({
                channel: channelId,
                ts: processingState.activityThreadMsgTs,
                text: formattedText,
                blocks,
              });
              console.log(`[Activity Thread] Thinking updated with retry button (upload failed)`);
            } catch (err) {
              console.error('[Activity Thread] Failed to update thinking with retry button:', err);
            }
          }
        } else if (content.length > charLimit) {
          // No existing message but content is long, post new one with attachment
          await postThinkingToThread(
            client,
            channelId,
            processingState.threadParentTs,
            finalEntry,
            charLimit,
            userId
          );
        } else if (processingState.activityThreadMsgTs) {
          // Update existing message with final content (short content, no attachment needed)
          const formattedText = formatThreadThinkingMessage(
            finalEntry, false, charLimit
          );
          try {
            await client.chat.update({
              channel: channelId,
              ts: processingState.activityThreadMsgTs,
              text: formattedText,
            });
          } catch (err) {
            console.error('[Activity Thread] Failed to finalize thinking in-place:', err);
          }
        } else {
          // No existing message and short content, post new one
          await postThinkingToThread(
            client,
            channelId,
            processingState.threadParentTs,
            finalEntry,
            charLimit,
            userId
          );
        }

        // Clear the thread message ts for next thinking block
        processingState.activityThreadMsgTs = null;
      }
    };

    // Track generating chunks for activity log
    let generatingChunkCount = 0;
    let generatingStartTime: number | null = null;

    // Helper to finalize generating entry and post segment (called when tool starts or streaming completes)
    // Posts: 1) frozen activity segment, 2) response text for that segment
    // isFinalSegment: only true for the LAST segment (enables Fork button)
    // skipPosting: if true, captures content for activity log but does NOT post as separate message
    const finalizeGeneratingEntry = async (segmentCharCount: number, isFinalSegment: boolean = false, skipPosting: boolean = false) => {
      const entry = processingState.activityLog.find(
        e => e.type === 'generating' && e.generatingInProgress
      );
      if (entry) {
        entry.generatingInProgress = false;
        entry.generatingChunks = generatingChunkCount;
        entry.generatingChars = segmentCharCount;
        entry.durationMs = Date.now() - (generatingStartTime || processingState.startTime);
        // Store response content for activity log
        entry.generatingContent = currentResponse;
        entry.generatingTruncated = currentResponse.length > 500
          ? currentResponse.substring(0, 500) + '...'
          : currentResponse;
        console.log(`[Activity] Generating complete: ${generatingChunkCount} chunks, ${segmentCharCount} chars`);
        // Reset for next generating block
        generatingChunkCount = 0;
        generatingStartTime = null;
      }

      // Post the current segment (activity + text) if there's response text
      // skipPosting: skip main channel post, but ALWAYS post to activity thread
      if (currentResponse.trim() && !isAborted(conversationKey)) {
        const liveConfig = getLiveSessionConfig(channelId, threadTs);
        const strippedResponse = stripMarkdownCodeFence(currentResponse, {
          stripEmptyTag: liveConfig.stripEmptyTag,
        });

        // 1. Main channel post - ONLY when NOT skipPosting
        if (!skipPosting) {
          try {
            const slackResponse = markdownToSlack(strippedResponse);
            // Add prefix for bot response
            const prefixedResponse = ':speech_balloon: *Response*\n' + slackResponse;

            // Pass mapping info for immediate save (point-in-time forking)
            // currentAssistantUuid is set when assistant message arrives
            // newSessionId is set when init message arrives
            const mappingInfo = (currentAssistantUuid && newSessionId)
              ? { sdkMessageId: currentAssistantUuid, sessionId: newSessionId }
              : undefined;

            const uploadResult = await uploadMarkdownAndPngWithResponse(
              client,
              channelId,
              strippedResponse,
              prefixedResponse,
              effectiveThreadTs,
              userId,
              liveConfig.threadCharLimit,
              liveConfig.stripEmptyTag,
              mappingInfo  // immediate mapping save
              // Note: Fork button now on activity message, not response
            );

            // Track successfully mapped UUIDs so we don't create placeholders for them
            if (uploadResult?.ts && mappingInfo) {
              mappedAssistantUuids.add(mappingInfo.sdkMessageId);
            }

            // Track upload failure for retry button
            if (uploadResult === null) {
              processingState.uploadFailed = true;
              console.log('[Interleaved] Upload failed, will show retry button');
            }

            console.log(`[Interleaved] Posted response segment: ${currentResponse.length} chars${mappingInfo ? ` (mapped: ${mappingInfo.sdkMessageId})` : ''}`);
          } catch (error) {
            console.error('[Interleaved] Error posting response segment:', error);
            processingState.uploadFailed = true;
          }
        }

        // 2. Activity thread post - always post when activity thread exists
        // This includes both intermediate text (before tools) and final responses
        // Main channel post is skipped via skipPosting, but thread gets all content
        if (processingState.threadParentTs) {
          // Build mapping info for the activity thread post (same as main channel)
          const threadMappingInfo = (currentAssistantUuid && newSessionId)
            ? { sdkMessageId: currentAssistantUuid, sessionId: newSessionId }
            : undefined;

          const threadPostTs = await postResponseToThread(
            client,
            channelId,
            processingState.threadParentTs,
            strippedResponse,
            entry?.durationMs,  // durationMs is optional
            liveConfig.threadCharLimit,
            userId
          ).catch(err => {
            console.error('[Activity Thread] Failed to post response to thread:', err);
            return null;
          });

          // Save mapping for activity thread post (required for Fork here functionality)
          if (threadPostTs && threadMappingInfo) {
            saveMessageMapping(channelId, threadPostTs, {
              sdkMessageId: threadMappingInfo.sdkMessageId,
              sessionId: threadMappingInfo.sessionId,
              type: 'assistant',
            });
            mappedAssistantUuids.add(threadMappingInfo.sdkMessageId);
            console.log(`[Activity Thread] Saved mapping: ${threadMappingInfo.sdkMessageId} -> ${threadPostTs}`);
          }
        }

        // Reset currentResponse for next segment (keep fullResponse for total tracking)
        currentResponse = '';

        // Status message stays at TOP - updated in place via chat.update
        // Response segments appear BELOW because they're posted after status was created
      }
    };

    // Helper to start or update generating entry (for text streaming visibility)
    const updateGeneratingEntry = (charCount: number) => {
      generatingChunkCount++;

      // Find existing generating entry or create new one
      const existingEntry = processingState.activityLog.find(
        e => e.type === 'generating' && e.generatingInProgress
      );

      if (existingEntry) {
        // Update existing entry
        existingEntry.generatingChunks = generatingChunkCount;
        existingEntry.generatingChars = charCount;
        existingEntry.durationMs = Date.now() - (generatingStartTime || processingState.startTime);
      } else {
        // Create new entry
        generatingStartTime = Date.now();
        const elapsedMs = Date.now() - processingState.startTime;
        processingState.activityLog.push({
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: generatingChunkCount,
          generatingChars: charCount,
          generatingInProgress: true,
          durationMs: elapsedMs,
        });
        processingState.status = 'generating';
        console.log(`[Activity] Generating started, total: ${processingState.activityLog.length} entries`);
      }
    };

    // Helper to add tool start to activity log and batch
    const logToolStart = async (toolName: string) => {
      // Finalize generating entry to capture content for activity log,
      // but skip posting intermediate text (e.g., "I'll do X...")
      await finalizeGeneratingEntry(currentResponse.length, false, true);  // skipPosting=true
      currentResponse = '';  // Discard after capturing

      const formattedName = formatToolName(toolName);
      const elapsedMs = Date.now() - processingState.startTime;
      const toolEntry: ActivityEntry = {
        timestamp: Date.now(),
        type: 'tool_start',
        tool: formattedName,
        durationMs: elapsedMs,  // Time since processing started
      };
      processingState.activityLog.push(toolEntry);
      // Also add to batch for thread posting
      processingState.activityBatch.push(toolEntry);
      processingState.currentTool = formattedName;
      processingState.status = 'tool';
      console.log(`[Activity] Tool start: ${formattedName}, total: ${processingState.activityLog.length} entries, batch: ${processingState.activityBatch.length}`);
    };

    // Helper to add tool complete to activity log and batch
    const logToolComplete = async (toolInput?: Record<string, unknown>, toolUseId?: string) => {
      // Finalize with skipPosting - text during tool execution is rare
      // but should be captured for activity log, not posted separately
      await finalizeGeneratingEntry(currentResponse.length, false, true);  // skipPosting=true
      currentResponse = '';  // Discard after capturing

      const lastToolStart = [...processingState.activityLog].reverse().find(e => e.type === 'tool_start');
      if (lastToolStart) {
        // Calculate duration from tool start to now
        const durationMs = Date.now() - lastToolStart.timestamp;

        // Pre-compute metrics from input for Edit/Write (don't need tool_result)
        let linesAdded: number | undefined;
        let linesRemoved: number | undefined;
        let lineCount: number | undefined;
        const toolLower = (lastToolStart.tool || '').toLowerCase();

        if (toolLower === 'edit' && toolInput) {
          linesRemoved = ((toolInput.old_string as string) || '').split('\n').length;
          linesAdded = ((toolInput.new_string as string) || '').split('\n').length;
        }
        if (toolLower === 'write' && toolInput) {
          lineCount = ((toolInput.content as string) || '').split('\n').length;
        }

        const toolCompleteEntry: ActivityEntry = {
          timestamp: Date.now(),
          type: 'tool_complete',
          tool: lastToolStart.tool,
          durationMs,
          toolInput,       // Store parsed input for activity display
          toolUseId,       // For matching with tool_result
          linesAdded,      // Pre-computed for Edit
          linesRemoved,    // Pre-computed for Edit
          lineCount,       // Pre-computed for Write
          toolCompleteTimestamp: Date.now(),  // For accurate execution time calculation
        };

        // Also update tool_start entry for in-progress display
        lastToolStart.toolInput = toolInput;
        lastToolStart.toolUseId = toolUseId;

        processingState.activityLog.push(toolCompleteEntry);

        // In batch, replace tool_start with tool_complete
        const batchStartIdx = processingState.activityBatch.findIndex(
          e => e.type === 'tool_start' && e.tool === lastToolStart.tool
        );
        if (batchStartIdx >= 0) {
          processingState.activityBatch[batchStartIdx] = toolCompleteEntry;
        } else {
          // tool_start was already flushed, add tool_complete to batch
          processingState.activityBatch.push(toolCompleteEntry);
        }
        console.log(`[Activity] Tool complete: ${lastToolStart.tool} (${durationMs}ms), total: ${processingState.activityLog.length} entries, batch: ${processingState.activityBatch.length}`);
      }
      processingState.toolsCompleted++;
      processingState.currentTool = undefined;
      processingState.status = 'thinking';
    };

    // Rate limit callback - posts notification on first hit, increments counter
    const handleRateLimit = async () => {
      processingState.rateLimitHits++;
      console.log(`[RateLimit] Hit #${processingState.rateLimitHits}`);

      // Post notification message only on first hit
      if (!processingState.rateLimitNotified) {
        processingState.rateLimitNotified = true;
        try {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: effectiveThreadTs,
            text: ':warning: Rate limited by Slack, retrying...',
          });
        } catch (err) {
          console.error('Error posting rate limit notification:', err);
        }
      }
    };

    // Update function for both messages (called by timer and events)
    const updateStatusMessages = async () => {
      const now = Date.now();

      // Cycle spinner on each update (proves bot is alive)
      processingState.spinnerIndex = (processingState.spinnerIndex + 1) % SPINNER_FRAMES.length;
      const spinner = SPINNER_FRAMES[processingState.spinnerIndex];

      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        const elapsedMs = now - processingState.startTime;

        // Compute live context% from per-turn data + session.lastUsage fallback
        const inProgressPerTurnTotal = (processingState.perTurnInputTokens || 0)
          + (processingState.perTurnCacheCreationInputTokens || 0)
          + (processingState.perTurnCacheReadInputTokens || 0);
        const inProgressContextWindow = processingState.contextWindow || session.lastUsage?.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const inProgressMaxOutput = processingState.maxOutputTokens || session.lastUsage?.maxOutputTokens;
        const inProgressContextPercent = inProgressContextWindow && inProgressPerTurnTotal > 0
          ? Math.min(100, Math.max(0, Number((inProgressPerTurnTotal / inProgressContextWindow * 100).toFixed(1))))
          : undefined;
        const inProgressAutoCompactThreshold = inProgressContextWindow
          ? computeAutoCompactThreshold(inProgressContextWindow, inProgressMaxOutput)
          : undefined;
        const inProgressCompactPercent = inProgressAutoCompactThreshold && inProgressPerTurnTotal > 0
          ? Math.max(0, Number(((inProgressAutoCompactThreshold - inProgressPerTurnTotal) / inProgressAutoCompactThreshold * 100).toFixed(1)))
          : undefined;
        const inProgressTokensToCompact = inProgressAutoCompactThreshold && inProgressPerTurnTotal > 0
          ? Math.max(0, inProgressAutoCompactThreshold - inProgressPerTurnTotal)
          : undefined;

        // Update combined message with CURRENT segment activity only
        // Completed segments have been posted as separate messages
        if (statusMsgTs) {
          try {
            await withSlackRetry(
              () =>
                client.chat.update({
                  channel: channelId,
                  ts: statusMsgTs,
                  blocks: buildCombinedStatusBlocks({
                    activityLog: processingState.activityLog,
                    inProgress: true,
                    status: processingState.status,
                    mode: session.mode,
                    model: processingState.model,
                    currentTool: processingState.currentTool,
                    toolsCompleted: processingState.toolsCompleted,
                    elapsedMs,
                    conversationKey,
                    spinner,
                    rateLimitHits: processingState.rateLimitHits,
                    sessionId: newSessionId || session.sessionId || undefined,
                    isNewSession: newSessionId !== null && session.sessionId === null,
                    contextPercent: inProgressContextPercent,
                    compactPercent: inProgressCompactPercent,
                    tokensToCompact: inProgressTokensToCompact,
                  }),
                  text: 'Claude is working...',
                }),
              { onRateLimit: handleRateLimit }
            );
          } catch (error) {
            console.error('Error updating combined status:', error);
          }
        }
      });

      processingState.lastUpdateTime = now;
    };

    // Periodic timer to update spinner even when no events are firing
    // Uses setTimeout pattern to re-read rate from processingState each tick
    // This allows /update-rate commands to take effect immediately
    // Also flushes pending activity batch to thread replies
    const scheduleUpdate = () => {
      const intervalMs = processingState.updateRateSeconds * 1000;
      spinnerTimer = setTimeout(async () => {
        // Flush pending activity batch to thread (respects rate limiting)
        const liveConfig = getLiveSessionConfig(channelId, threadTs);
        await flushActivityBatch(
          processingState,
          client,
          channelId,
          liveConfig.threadCharLimit,
          'timer',
          userId
        );
        // Update status message (spinner)
        updateStatusMessages();

        scheduleUpdate();  // Reschedule with potentially new rate
      }, intervalMs);
    };
    scheduleUpdate();

    // Track whether query completed successfully (for isFinalSegment detection)
    let isQueryComplete = false;

    for await (const msg of claudeQuery) {
      // Capture ALL assistant message UUIDs for message mapping (point-in-time forking)
      // IMPORTANT: With extended thinking, SDK emits MULTIPLE assistant messages:
      // - One for thinking content (uuid=X)
      // - One for text content (uuid=Y)
      // We must track ALL UUIDs so /ff can filter out all Slack-originated messages
      if (msg.type === 'assistant' && (msg as any).uuid) {
        const uuid = (msg as any).uuid;
        assistantMessageUuids.add(uuid);
        currentAssistantUuid = uuid;  // Track current UUID for immediate mapping
        console.log(`[Mapping] Captured assistant message UUID: ${uuid} (total: ${assistantMessageUuids.size})`);
        // Track generating activity for user visibility (shows text is being streamed)
        updateGeneratingEntry(currentResponse.length);
        // Capture per-turn usage from assistant message (CLI uses last assistant msg, not cumulative)
        const assistantMsg = msg as any;
        if (assistantMsg.message?.usage) {
          const u = assistantMsg.message.usage;
          processingState.perTurnInputTokens = u.input_tokens || 0;
          processingState.perTurnCacheReadInputTokens = u.cache_read_input_tokens || 0;
          processingState.perTurnCacheCreationInputTokens = u.cache_creation_input_tokens || 0;
        }
      }

      // Capture session ID and model from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        newSessionId = (msg as any).session_id;
        modelName = (msg as any).model;
        processingState.model = modelName;
        processingState.sessionId = newSessionId || undefined;  // Track for abort handler
        console.log(`Session initialized: ${newSessionId}, model: ${modelName}`);

        // CRITICAL: Save session ID immediately, not at end of try block
        // If SDK crashes after init but before completion, we need the sessionId
        // saved so subsequent messages can RESUME instead of trying to fork again
        if (newSessionId) {
          if (threadTs) {
            await saveThreadSession(channelId, threadTs, { sessionId: newSessionId });
            console.log(`[Init] Saved thread session ID: ${newSessionId}`);
          } else {
            await saveSession(channelId, { sessionId: newSessionId });
            console.log(`[Init] Saved main session ID: ${newSessionId}`);
          }
        }

        // Update model in active query for abort handler
        const activeQuery = activeQueries.get(conversationKey);
        if (activeQuery) {
          activeQuery.model = modelName;
        }

        // Model name updated in memory - timer will render at next interval
      }

      // Detect compaction START (works for both manual and auto)
      if (msg.type === 'system' &&
          (msg as any).subtype === 'status' &&
          (msg as any).status === 'compacting') {
        // For regular message handler, this is auto-compact
        await handleCompactionStart(client, channelId, threadTs, processingState, false, handleRateLimit);
      }

      // Capture pre_tokens from compact_boundary
      if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
        const metadata = (msg as any).compact_metadata;
        processingState.compactPreTokens = metadata?.pre_tokens ?? null;
        console.log(`[AutoCompact] Boundary - pre_tokens: ${processingState.compactPreTokens}`);
        // Update ⚙️ → 🏁 immediately (line 3938 call becomes no-op via guard)
        await handleCompactionEnd(client, channelId, processingState, handleRateLimit);
      }

      // Handle stream_event for real-time activity tracking
      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;

        // Thinking block started - create in-progress entry for live display
        // First finalize any accumulated text to create segment boundary
        if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          // Post any accumulated text as its own segment before thinking starts
          // This ensures text→thinking→text produces 3 segments, not 2
          await finalizeGeneratingEntry(currentResponse.length);
          console.log('[Activity] Thinking block started');
          processingState.currentThinkingIndex = event.index;
          processingState.currentThinkingContent = '';
          processingState.status = 'thinking';
          await startThinkingEntry();
          // Timer will render updated status at next interval
        }

        // Thinking content streaming - update rolling window (last 500 chars)
        if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          const prevLen = processingState.currentThinkingContent.length;
          processingState.currentThinkingContent += event.delta.thinking || '';
          updateThinkingEntry(processingState.currentThinkingContent);
          // Log periodically (every ~1000 chars) to avoid spam
          if (Math.floor(processingState.currentThinkingContent.length / 1000) > Math.floor(prevLen / 1000)) {
            console.log(`[Activity] Thinking delta: ${processingState.currentThinkingContent.length} chars total`);
          }
        }

        // Thinking block completed - finalize entry with full content and post to thread
        if (event?.type === 'content_block_stop' &&
            processingState.currentThinkingIndex === event.index &&
            processingState.currentThinkingContent) {
          await finalizeThinkingEntry(processingState.currentThinkingContent);
          processingState.currentThinkingContent = '';
          processingState.currentThinkingIndex = null;
          // Timer will render updated status at next interval
        }

        // Text streaming - accumulate in real-time for interleaved posting
        // This ensures currentResponse has content BEFORE tool events trigger finalizeGeneratingEntry
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const textChunk = event.delta.text || '';
          currentResponse += textChunk;
          fullResponse += textChunk;
          updateGeneratingEntry(currentResponse.length);
        }

        // Tool use started
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          processingState.currentToolUseIndex = event.index;
          await logToolStart(event.content_block.name);

          // Track ExitPlanMode for input accumulation (CLI-fidelity plan approval)
          if (event.content_block.name === 'ExitPlanMode') {
            processingState.exitPlanModeIndex = event.index;
            processingState.exitPlanModeInputJson = '';
            console.log('[ExitPlanMode] Tool started at index:', event.index);
          }

          // Track ALL tool_use blocks for activity display and plan file path capture
          if (event.content_block?.type === 'tool_use') {
            processingState.toolInputs.set(event.index, '');
            if (event.content_block.id) {
              processingState.toolUseIds.set(event.index, event.content_block.id);
            }
          }

          // Timer will render updated status at next interval
        }

        // Accumulate JSON input for ExitPlanMode tool
        // Field is 'partial_json' (confirmed in plans/native-limit-vs-rate-summary.md:877)
        if (event?.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            processingState.exitPlanModeIndex === event.index) {
          processingState.exitPlanModeInputJson += event.delta.partial_json || '';
        }

        // Accumulate JSON input for all tools (activity display + plan file capture)
        if (event?.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            processingState.toolInputs.has(event.index)) {
          const current = processingState.toolInputs.get(event.index) || '';
          processingState.toolInputs.set(event.index, current + (event.delta.partial_json || ''));
        }

        // Tool use completed (content_block_stop for tool_use block)
        if (event?.type === 'content_block_stop' &&
            processingState.currentToolUseIndex === event.index &&
            processingState.currentTool) {

          // Parse tool input for activity display and plan file capture
          const inputJson = processingState.toolInputs.get(event.index) || '{}';
          const toolUseId = processingState.toolUseIds.get(event.index);
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(inputJson);
          } catch (e) {
            console.error('[Tool] Failed to parse input JSON:', e);
          }

          await logToolComplete(toolInput, toolUseId);

          // Parse ExitPlanMode input when tool completes
          if (processingState.exitPlanModeIndex === event.index) {
            try {
              processingState.exitPlanModeInput = JSON.parse(processingState.exitPlanModeInputJson || '{}');
              console.log('[ExitPlanMode] Parsed input:', JSON.stringify(processingState.exitPlanModeInput));
            } catch (e) {
              // Set to null on parse failure (not {} which is truthy and would trigger UI)
              console.error('[ExitPlanMode] JSON parse failed:', e);
              processingState.exitPlanModeInput = null;
            }
            processingState.exitPlanModeIndex = null;
            processingState.exitPlanModeInputJson = '';

            // CRITICAL: In plan mode, interrupt query to show approval buttons
            // This prevents Claude from continuing with "plan approved" and implementation
            if (session.mode === 'plan' && processingState.exitPlanModeInput !== null) {
              console.log('[ExitPlanMode] Interrupting query in plan mode to show approval buttons');
              await claudeQuery.interrupt();
            }
          }

          // Capture plan file path from file tools (Write/Edit/Read)
          // Uses shared function to filter out directory paths (must end with .md)
          const planPath = extractPlanFilePathFromInput(toolInput);
          if (planPath) {
            processingState.planFilePath = planPath;
            // Persist to session for cross-turn access
            if (threadTs) {
              await saveThreadSession(channelId, threadTs, { planFilePath: planPath });
            } else {
              await saveSession(channelId, { planFilePath: planPath });
            }
            console.log('[PlanFile] Detected and persisted plan file:', planPath);
          }

          // Cleanup tool tracking
          processingState.toolInputs.delete(event.index);
          processingState.toolUseIds.delete(event.index);

          processingState.currentToolUseIndex = null;
          // Timer will render updated status at next interval
        }

        // Text block started - model is responding (no thinking/tools needed)
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
          if (processingState.status === 'starting') {
            processingState.status = 'thinking'; // Show as "thinking" even for direct text response
            // Timer will render updated status at next interval
          }
        }
      }

      // Note: Text accumulation moved to text_delta handler in stream_event section
      // This ensures currentResponse has content BEFORE tool events trigger segment posting

      // Handle tool results from user messages (arrives mid-query)
      // SDK sends tool_result via msg.type === 'user' messages, not result messages
      if (msg.type === 'user') {
        const userMsg = msg as any;
        if (Array.isArray(userMsg.message?.content)) {
          for (const block of userMsg.message.content) {
            // Process ALL tool_result blocks (both success and error)
            if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string' ? block.content : '';
              const toolUseId = block.tool_use_id;
              const isError = block.is_error === true;

              // Find matching tool_complete entry by tool_use_id
              const matchingEntry = [...processingState.activityLog]
                .reverse()
                .find(e => e.type === 'tool_complete' && e.toolUseId === toolUseId);

              if (matchingEntry) {
                // Calculate actual execution time (from content_block_stop to tool_result)
                const resultTimestamp = Date.now();
                matchingEntry.toolResultTimestamp = resultTimestamp;
                if (matchingEntry.toolCompleteTimestamp) {
                  matchingEntry.executionDurationMs = resultTimestamp - matchingEntry.toolCompleteTimestamp;
                  matchingEntry.durationMs = matchingEntry.executionDurationMs;  // Update displayed duration
                }

                // Handle error vs success cases
                if (isError) {
                  matchingEntry.toolIsError = true;
                  matchingEntry.toolErrorMessage = resultContent.slice(0, 500);
                } else {
                  // Check for binary content (control chars in first 1000 bytes)
                  // Exclude \x1B (ESC) since it's used for ANSI color codes in terminal output
                  const isBinary = /[\x00-\x08\x0E-\x1A\x1C-\x1F]/.test(resultContent.slice(0, 1000));
                  if (isBinary) {
                    matchingEntry.toolOutputPreview = '[Binary content]';
                  } else {
                    const MAX_FULL = 50 * 1024;  // 50KB
                    const PREVIEW_LEN = 300;

                    matchingEntry.toolOutput = resultContent.slice(0, MAX_FULL);
                    matchingEntry.toolOutputTruncated = resultContent.length > MAX_FULL;

                    // Strip ANSI codes for clean preview display
                    const cleanedContent = stripAnsiCodes(resultContent);

                    // Handle empty output
                    if (cleanedContent.length === 0) {
                      matchingEntry.toolOutputPreview = '[No output]';
                    } else {
                      matchingEntry.toolOutputPreview = cleanedContent.slice(0, PREVIEW_LEN);
                      if (cleanedContent.length > PREVIEW_LEN) {
                        matchingEntry.toolOutputPreview += '...';
                      }
                    }
                  }

                  // Extract metrics based on tool type (only for successful results)
                  const toolName = (matchingEntry.tool || '').toLowerCase();
                  if (toolName === 'read') {
                    matchingEntry.lineCount = resultContent.split('\n').filter((l: string) => l.length > 0).length;
                  } else if (toolName === 'grep' || toolName === 'glob') {
                    matchingEntry.matchCount = resultContent.split('\n').filter((l: string) => l.length > 0).length;
                  }
                  // Edit/Write metrics already computed from input in logToolComplete
                }

                console.log(`[Activity] Tool result for ${matchingEntry.tool}: isError=${isError}, durationMs=${matchingEntry.durationMs}, lineCount=${matchingEntry.lineCount}, matchCount=${matchingEntry.matchCount}`);

                // Update already-posted thread batch if this tool was in it (race condition fix)
                if (toolUseId && processingState.postedBatchToolUseIds?.has(toolUseId)) {
                  const { updatePostedBatch } = await import('./activity-thread.js');
                  await updatePostedBatch(
                    processingState,
                    client,
                    channelId,
                    processingState.activityLog,
                    toolUseId
                  );
                }
              }
            }
          }
        }
      }

      // Handle result messages (final response with stats)
      if (msg.type === 'result') {
        const resultMsg = msg as any;
        isActivelyStreaming = false;  // No longer in middle of streaming
        isQueryComplete = true;  // Query completed successfully - enable Fork button on final segment

        // Only use result as fallback if accumulation failed (matches streaming.ts pattern)
        // This preserves intermediate text outputs that were accumulated via +=
        // Also update currentResponse for interleaved posting support
        if (resultMsg.result && !fullResponse) {
          fullResponse = resultMsg.result;
          currentResponse = resultMsg.result;  // For interleaved posting
        }
        // Extract stats from result message
        processingState.durationMs = resultMsg.duration_ms;
        if (resultMsg.usage) {
          processingState.inputTokens = resultMsg.usage.input_tokens || 0;
          processingState.outputTokens = resultMsg.usage.output_tokens || 0;
          // Cache tokens are needed for accurate context % calculation
          processingState.cacheReadInputTokens = resultMsg.usage.cache_read_input_tokens || 0;
          processingState.cacheCreationInputTokens = resultMsg.usage.cache_creation_input_tokens || 0;
        }
        // Extract cost and context window from SDK result
        if (resultMsg.total_cost_usd !== undefined) {
          costUsd = resultMsg.total_cost_usd;
          processingState.costUsd = costUsd;
        }
        // Model usage is a dictionary keyed by model name
        if (resultMsg.modelUsage && processingState.model) {
          const modelData = resultMsg.modelUsage[processingState.model];
          if (modelData?.contextWindow) {
            processingState.contextWindow = modelData.contextWindow;
          }
          if (modelData?.maxOutputTokens) {
            processingState.maxOutputTokens = modelData.maxOutputTokens;
          }
        }
      }
    }

    // Finalize the final segment (posts remaining activity + currentResponse if any)
    // This handles the case where the query ends with a response (not a tool)
    // Pass isQueryComplete to enable Fork button on successful completion
    // Skip main channel posting when activity thread exists (response appears only in thread)
    const hasActivityThread = processingState.threadParentTs != null;
    if (generatingChunkCount > 0 || currentResponse.trim()) {
      await finalizeGeneratingEntry(currentResponse.length, isQueryComplete, hasActivityThread);
    }

    // Stop the spinner timer now that processing is complete
    clearTimeout(spinnerTimer);

    // Send auto-compact completion message using shared helper
    await handleCompactionEnd(client, channelId, processingState, handleRateLimit);

    // Flush any remaining activity batch to thread
    if (processingState.activityBatch.length > 0) {
      const liveConfig = getLiveSessionConfig(channelId, threadTs);
      await flushActivityBatch(
        processingState,
        client,
        channelId,
        liveConfig.threadCharLimit,
        'complete',
        userId
      );
    }

    // Calculate context percentage using per-turn usage from last assistant message
    // CLI formula: total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    const perTurnTotal = (processingState.perTurnInputTokens || 0)
      + (processingState.perTurnCacheCreationInputTokens || 0)
      + (processingState.perTurnCacheReadInputTokens || 0);
    const contextPercent = processingState.contextWindow && perTurnTotal > 0
      ? Math.min(100, Math.max(0, Number((perTurnTotal / processingState.contextWindow * 100).toFixed(1))))
      : undefined;

    // Calculate % left until auto-compact triggers
    // CLI formula: denominator = threshold (not contextWindow), capped maxOutputTokens at 32k
    const autoCompactThreshold = processingState.contextWindow
      ? computeAutoCompactThreshold(processingState.contextWindow, processingState.maxOutputTokens)
      : undefined;
    const compactPercent = autoCompactThreshold && perTurnTotal > 0
      ? Math.max(0, Number(((autoCompactThreshold - perTurnTotal) / autoCompactThreshold * 100).toFixed(1)))
      : undefined;
    const tokensToCompact = autoCompactThreshold && perTurnTotal > 0
      ? Math.max(0, autoCompactThreshold - perTurnTotal)
      : undefined;

    // Store in processingState for abort handler access
    processingState.contextPercent = contextPercent;
    processingState.compactPercent = compactPercent;
    processingState.tokensToCompact = tokensToCompact;

    // Final elapsed time
    const finalDurationMs = processingState.durationMs ?? (Date.now() - processingState.startTime);

    // Update combined message to completion state (only if not aborted)
    // Activity stays in status message - no separate activity posting
    if (!isAborted(conversationKey)) {
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        // Update status message to completion state with FULL activity log
        if (statusMsgTs) {
          try {
            // Build completion blocks with full activity log
            const completionBlocks = buildCombinedStatusBlocks({
              activityLog: processingState.activityLog,
              inProgress: false,
              status: 'complete',
              mode: session.mode,
              model: processingState.model,
              toolsCompleted: processingState.toolsCompleted,
              elapsedMs: finalDurationMs,
              inputTokens: processingState.inputTokens,
              outputTokens: processingState.outputTokens,
              contextPercent,
              compactPercent,
              tokensToCompact,
              costUsd: processingState.costUsd,
              conversationKey: activityLogKey,
              rateLimitHits: processingState.rateLimitHits,
              sessionId: newSessionId || session.sessionId || undefined,
              isNewSession: newSessionId !== null && session.sessionId === null,
              isFinalSegment: isQueryComplete,  // Show Fork button on successful completion
              forkInfo: {
                threadTs,
                conversationKey,
                sdkMessageId: currentAssistantUuid || undefined,
                sessionId: newSessionId || session.sessionId || undefined,
              },
              hasFailedUpload: processingState.uploadFailed,
              retryUploadInfo: processingState.uploadFailed
                ? {
                    activityLogKey,  // Use activityLogKey, NOT conversationKey
                    channelId,
                    threadTs,  // Pass explicitly for thread/channel parity
                    statusMsgTs: statusMsgTs!,
                  }
                : undefined,
            });

            await withSlackRetry(() =>
              client.chat.update({
                channel: channelId,
                ts: statusMsgTs,
                blocks: completionBlocks,
                text: 'Complete',
              })
            );
          } catch (error) {
            console.error('Error updating to complete:', error);
          }
        }
      });

      // Save usage data for /status and /context commands
      // Use per-turn values (from last assistant message) for accurate context %, matching CLI behavior
      if (processingState.model && processingState.contextWindow) {
        const lastUsage: LastUsage = {
          inputTokens: processingState.perTurnInputTokens || 0,
          outputTokens: processingState.outputTokens || 0,
          cacheReadInputTokens: processingState.perTurnCacheReadInputTokens || 0,
          cacheCreationInputTokens: processingState.perTurnCacheCreationInputTokens || 0,
          contextWindow: processingState.contextWindow,
          model: processingState.model,
          maxOutputTokens: processingState.maxOutputTokens,
        };
        const perTurnContextTotal = lastUsage.inputTokens + (lastUsage.cacheCreationInputTokens ?? 0) + lastUsage.cacheReadInputTokens;
        if (threadTs) {
          await saveThreadSession(channelId, threadTs, { lastUsage });
          console.log(`[Usage] Saved thread lastUsage: ${perTurnContextTotal}/${lastUsage.contextWindow} tokens (${Math.round(perTurnContextTotal / lastUsage.contextWindow * 100)}%)`);
        } else {
          await saveSession(channelId, { lastUsage });
          console.log(`[Usage] Saved lastUsage: ${perTurnContextTotal}/${lastUsage.contextWindow} tokens (${Math.round(perTurnContextTotal / lastUsage.contextWindow * 100)}%)`);
        }
      }
    }

    // CRITICAL: Save message mappings for /ff filtering AFTER query completes
    // At this point, SDK has written all messages to the session file
    //
    // We track BOTH user and assistant UUIDs to prevent /ff from re-importing:
    // 1. User message - read UUID from session file (not available at init time)
    // 2. Assistant messages - ALREADY saved via immediate mapping in uploadMarkdownAndPngWithResponse
    //    Only need placeholders for UUIDs that weren't immediately mapped (e.g., thinking UUIDs)
    //
    // Edge cases:
    // - newSessionId null: SDK crashed before init - skip (nothing to track)
    // - assistantMessageUuids empty: No assistant response - skip (nothing to track)
    if (newSessionId) {
      // 1. Capture user message UUID from session file (NOW it's written)
      if (originalTs) {
        const sessionFilePath = getSessionFilePath(newSessionId, session.workingDir);
        const userUuid = readLastUserMessageUuid(sessionFilePath);
        if (userUuid) {
          await saveMessageMapping(channelId, originalTs, {
            sdkMessageId: userUuid,
            sessionId: newSessionId,
            type: 'user',
          });
          // Track as Slack-originated so /ff skips it (message already visible in Slack)
          await addSlackOriginatedUserUuid(channelId, userUuid, threadTs);
          console.log(`[Mapping] Saved user message UUID: ${userUuid}`);
        } else {
          // Fallback to placeholder if file read fails
          const placeholderUuid = `user_${originalTs}`;
          await saveMessageMapping(channelId, originalTs, {
            sdkMessageId: placeholderUuid,
            sessionId: newSessionId,
            type: 'user',
          });
          // FIX: Also track as Slack-originated so /ff skips it (message already visible in Slack)
          await addSlackOriginatedUserUuid(channelId, placeholderUuid, threadTs);
          console.log(`[Mapping] Saved user message placeholder (file read failed): ${placeholderUuid}`);
        }
      }

      // 2. Save placeholder mappings ONLY for UUIDs that weren't immediately mapped
      // With the new immediate mapping, most text UUIDs are mapped to real Slack ts
      // We still need placeholders for:
      // - Thinking UUIDs (extended thinking): SDK emits separate UUID for thinking content
      // - Failed posts: if uploadMarkdownAndPngWithResponse returns null
      if (assistantMessageUuids.size > 0) {
        const unmappedUuids = Array.from(assistantMessageUuids).filter(
          uuid => !mappedAssistantUuids.has(uuid)
        );

        if (unmappedUuids.length > 0) {
          console.log(`[Mapping] Saving placeholders for ${unmappedUuids.length} unmapped UUIDs (${mappedAssistantUuids.size} already mapped)`);
          for (const uuid of unmappedUuids) {
            const placeholderTs = `_slack_${uuid}`;
            await saveMessageMapping(channelId, placeholderTs, {
              sdkMessageId: uuid,
              sessionId: newSessionId!,
              type: 'assistant',
            });
            console.log(`[Mapping] Saved placeholder for unmapped assistant UUID: ${uuid}`);
          }
        } else {
          console.log(`[Mapping] All ${assistantMessageUuids.size} assistant UUIDs were immediately mapped`);
        }
      }
    }

    // Check if in plan mode and Claude called ExitPlanMode tool
    // If so, add CLI-style plan approval buttons with permissions display
    // IMPORTANT: This is OUTSIDE the fullResponse check - approval buttons must show
    // even if Claude didn't output text (e.g., only wrote plan file then called ExitPlanMode)
    if (!isAborted(conversationKey) && session.mode === 'plan' && processingState.exitPlanModeInput !== null) {
      await showPlanApprovalUI({
        client,
        channelId,
        threadTs: effectiveThreadTs,
        userId,
        conversationKey,
        planFilePath: processingState.planFilePath,
        exitPlanModeInput: processingState.exitPlanModeInput,
        statusMsgTs,
        processingState: {
          model: processingState.model,
          toolsCompleted: processingState.toolsCompleted,
          startTime: processingState.startTime,
          activityLog: processingState.activityLog,
          inputTokens: processingState.inputTokens,
          outputTokens: processingState.outputTokens,
          contextPercent,
          compactPercent,
          tokensToCompact,
          costUsd: processingState.costUsd,
          durationMs: processingState.durationMs,
          rateLimitHits: processingState.rateLimitHits,
          sessionId: newSessionId || session.sessionId || undefined,
        },
        session,
        originalTs,
      });
    } else {
      // Remove eyes reaction (only if not plan mode with ExitPlanMode - helper handles that case)
      if (originalTs) {
        try {
          await client.reactions.remove({
            channel: channelId,
            timestamp: originalTs,
            name: 'eyes',
          });
        } catch (error) {
          console.error('Error removing reaction:', error);
        }
      }
    }

    // Note: Session ID was already saved at init time (line ~1662)
    // This is a redundant save for extra safety - no-op if already saved

  } catch (error: any) {
    console.error('Error streaming Claude response:', error);

    // Stop spinner timer immediately
    if (spinnerTimer) {
      clearTimeout(spinnerTimer);
      spinnerTimer = undefined;
    }

    // Safety net: Check if this is an ExitPlanMode interrupt (not a real error)
    // NOTE: Testing shows interrupt() typically completes normally without throwing.
    // The normal completion path at line ~2596 handles ExitPlanMode approval UI.
    // This catch block is a fallback in case SDK behavior changes or edge cases occur.
    // See: sdk-live/interrupt-error-format.test.ts for documented SDK behavior.
    const isExitPlanModeInterrupt =
      session.mode === 'plan' &&
      processingState.exitPlanModeInput !== null &&
      !isAborted(conversationKey) &&  // Don't show buttons if user aborted
      error.message?.includes('exited with code 1');

    if (isExitPlanModeInterrupt) {
      console.log('[ExitPlanMode] Detected interrupt, showing approval buttons');

      // Compute context% from per-turn data + lastUsage contextWindow fallback
      const catchPerTurnTotal = (processingState.perTurnInputTokens || 0)
        + (processingState.perTurnCacheCreationInputTokens || 0)
        + (processingState.perTurnCacheReadInputTokens || 0);
      const catchContextWindow = processingState.contextWindow || session.lastUsage?.contextWindow || DEFAULT_CONTEXT_WINDOW;
      const catchMaxOutput = processingState.maxOutputTokens || session.lastUsage?.maxOutputTokens;
      const catchContextPercent = catchContextWindow && catchPerTurnTotal > 0
        ? Math.min(100, Math.max(0, Number((catchPerTurnTotal / catchContextWindow * 100).toFixed(1))))
        : undefined;
      const catchAutoCompactThreshold = catchContextWindow
        ? computeAutoCompactThreshold(catchContextWindow, catchMaxOutput)
        : undefined;
      const catchCompactPercent = catchAutoCompactThreshold && catchPerTurnTotal > 0
        ? Math.max(0, Number(((catchAutoCompactThreshold - catchPerTurnTotal) / catchAutoCompactThreshold * 100).toFixed(1)))
        : undefined;
      const catchTokensToCompact = catchAutoCompactThreshold && catchPerTurnTotal > 0
        ? Math.max(0, catchAutoCompactThreshold - catchPerTurnTotal)
        : undefined;

      await showPlanApprovalUI({
        client,
        channelId,
        threadTs: effectiveThreadTs,
        userId,
        conversationKey,
        planFilePath: processingState.planFilePath,
        exitPlanModeInput: processingState.exitPlanModeInput,
        statusMsgTs,
        processingState: {
          model: processingState.model,
          toolsCompleted: processingState.toolsCompleted,
          startTime: processingState.startTime,
          activityLog: processingState.activityLog,
          inputTokens: processingState.inputTokens,
          outputTokens: processingState.outputTokens,
          contextPercent: catchContextPercent,
          compactPercent: catchCompactPercent,
          tokensToCompact: catchTokensToCompact,
          costUsd: processingState.costUsd,
          durationMs: processingState.durationMs,
          rateLimitHits: processingState.rateLimitHits,
          sessionId: processingState.sessionId || session.sessionId || undefined,
        },
        session,
        originalTs,
      });

      return; // Exit early - don't show error to user
    }

    // Update combined message to error state (only if not aborted)
    if (!isAborted(conversationKey)) {
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        // Flush any pending activity batch before posting error
        if (processingState.activityBatch.length > 0 && processingState.threadParentTs) {
          await flushActivityBatch(
            processingState,
            client,
            channelId,
            processingState.charLimit,
            'complete'
          );
        }

        // Add error to activity log
        processingState.activityLog.push({
          timestamp: Date.now(),
          type: 'error',
          message: error.message,
        });

        // Post error to thread
        if (processingState.threadParentTs) {
          await postErrorToThread(
            client,
            channelId,
            processingState.threadParentTs,
            error.message
          );
        }

        // Update combined message to error state
        if (statusMsgTs) {
          try {
            await client.chat.update({
              channel: channelId,
              ts: statusMsgTs,
              blocks: buildCombinedStatusBlocks({
                activityLog: processingState.activityLog,
                inProgress: false,
                status: 'error',
                mode: session.mode,
                toolsCompleted: processingState.toolsCompleted,
                elapsedMs: Date.now() - processingState.startTime,
                conversationKey,
                errorMessage: error.message,
                sessionId: processingState.sessionId || session.sessionId || undefined,
                // Error states: show stats if we have them
                inputTokens: processingState.inputTokens,
                outputTokens: processingState.outputTokens,
                contextPercent: processingState.contextPercent,
                compactPercent: processingState.compactPercent,
                tokensToCompact: processingState.tokensToCompact,
                costUsd: processingState.costUsd,
              }),
              text: `Error: ${error.message}`,
            });
          } catch (e) {
            console.error('Error updating to error:', e);
          }
        }
      });
    }

    // Remove eyes reaction on error
    if (originalTs) {
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: originalTs,
          name: 'eyes',
        });
      } catch (e) {
        // Ignore
      }
    }

    // Note: Error already posted to activity thread and status message above
    // No additional error posting needed here
  } finally {
    // Clear spinner timer to prevent memory leak (important if error occurs before normal cleanup)
    if (spinnerTimer) {
      clearTimeout(spinnerTimer);
    }
    // Only clear busy state if NOT waiting for plan approval
    if (!pendingPlanApprovals.has(conversationKey)) {
      busyConversations.delete(conversationKey);
    }
    activeQueries.delete(conversationKey);
    clearAborted(conversationKey);
    cleanupMutex(conversationKey);
  }
}

// Handle button clicks for ask_user tool
app.action(/^answer_(.+)_(\d+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging button click:', error);
    // ack() failed but we should still try to process the answer
  }

  // Extract question ID from action_id: "answer_{questionId}_{index}"
  // Use regex to properly extract questionId (which contains underscores)
  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^answer_(.+)_(\d+)$/);
  const questionId = match ? match[1] : '';
  const answer = 'value' in action ? action.value : '';

  console.log(`Button clicked: questionId=${questionId}, answer=${answer}`);

  // Write answer to file for MCP subprocess to read
  const answerFile = `${ANSWER_DIR}/${questionId}.json`;
  try {
    fs.writeFileSync(answerFile, JSON.stringify({ answer, timestamp: Date.now() }));
    console.log(`Wrote answer file: ${answerFile}`);
  } catch (error) {
    console.error('Error writing answer file:', error);
  }

  // Update message to show selection
  const bodyWithChannel = body as any;
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `You selected: *${answer}*`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating message:', error);
    }
  }
});

// Helper function to execute MCP question abort logic (called from modal submission)
async function handleQuestionAbort(questionId: string, channelId: string, messageTs: string, client: WebClient): Promise<void> {
  console.log(`Aborting MCP question: ${questionId}`);

  // Write abort answer to file
  const answerFile = `${ANSWER_DIR}/${questionId}.json`;
  try {
    fs.writeFileSync(answerFile, JSON.stringify({ answer: '__ABORTED__', timestamp: Date.now() }));
    console.log(`Wrote abort file: ${answerFile}`);
  } catch (error) {
    console.error('Error writing abort file:', error);
  }

  // Clear any pending multiselect for this question
  pendingSelections.delete(questionId);

  // Update message to show aborted
  if (channelId && messageTs) {
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `*Aborted* - Question cancelled by user`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating message:', error);
    }
  }
}

// Handle "Abort" button for ask_user questions - opens confirmation modal
// Note: (?!query_) prevents matching abort_query_* which has its own handler
app.action(/^abort_(?!query_)(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging abort click:', error);
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^abort_(?!query_)(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`Abort clicked for question: ${questionId}`);

  const bodyWithTrigger = body as any;
  const channelId = bodyWithTrigger.channel?.id;
  const messageTs = bodyWithTrigger.message?.ts;

  if (!bodyWithTrigger.trigger_id || !channelId) {
    console.error('Missing trigger_id or channelId for abort modal');
    if (channelId && bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
    return;
  }

  try {
    await client.views.open({
      trigger_id: bodyWithTrigger.trigger_id,
      view: buildAbortConfirmationModalView({
        abortType: 'question',
        key: questionId,
        channelId,
        messageTs: messageTs || '',
      }),
    });
  } catch (error) {
    console.error('Error opening abort confirmation modal:', error);
    if (bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
  }
});

// Handle multi-select selection changes (stores selection, doesn't submit yet)
app.action(/^multiselect_(?!submit_)(.+)$/, async ({ action, ack }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging multiselect change:', error);
    // ack() failed but we should still try to store the selection
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^multiselect_(.+)$/);
  const questionId = match ? match[1] : '';

  // Get selected options from the action
  const selectedOptions = 'selected_options' in action ? action.selected_options : [];
  const selections = selectedOptions?.map((opt: any) => opt.value) || [];

  console.log(`Multi-select changed for ${questionId}: ${selections.join(', ')}`);

  // Store selections (will be submitted when user clicks Submit)
  pendingSelections.set(questionId, selections);
});

// Handle multi-select submit button
app.action(/^multiselect_submit_(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging multiselect submit:', error);
    // ack() failed but we should still try to process the submission
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^multiselect_submit_(.+)$/);
  const questionId = match ? match[1] : '';

  // Get pending selections
  const selections = pendingSelections.get(questionId) || [];
  const answer = selections.join(', ');

  console.log(`Multi-select submitted for ${questionId}: ${answer}`);

  // Write answer to file
  const answerFile = `${ANSWER_DIR}/${questionId}.json`;
  try {
    fs.writeFileSync(answerFile, JSON.stringify({ answer, timestamp: Date.now() }));
    console.log(`Wrote answer file: ${answerFile}`);
  } catch (error) {
    console.error('Error writing answer file:', error);
  }

  // Clear pending selections
  pendingSelections.delete(questionId);

  // Update message to show selection
  const bodyWithChannel = body as any;
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `You selected: *${answer || '(none)'}*`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating message:', error);
    }
  }
});

// Helper function to execute query abort logic (called from modal submission)
async function handleQueryAbort(conversationKey: string, channelId: string, client: WebClient): Promise<void> {
  const active = activeQueries.get(conversationKey);
  if (active) {
    // Mark as aborted FIRST to prevent race condition with "Done" update
    markAborted(conversationKey);

    try {
      // Call interrupt() on the query - same as ESC in CLI
      await active.query.interrupt();
      console.log(`Interrupted query for: ${conversationKey}`);
    } catch (error) {
      console.error('Error interrupting query:', error);
    }

    // Add 'aborted' entry to activity log (with duplicate prevention)
    const hasAborted = active.processingState.activityLog.some(e => e.type === 'aborted');
    if (!hasAborted) {
      const abortedEntry: ActivityEntry = {
        timestamp: Date.now(),
        type: 'aborted',
      };
      active.processingState.activityLog.push(abortedEntry);
      active.processingState.activityBatch.push(abortedEntry);
    }

    if (channelId) {
      // Use mutex to ensure abort update comes after any in-flight status update
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        const elapsedMs = Date.now() - active.processingState.startTime;

        // Parse conversationKey to get session for lastUsage fallback
        const [abortChannelId, abortThreadTs] = conversationKey.includes('_')
          ? conversationKey.split('_')
          : [conversationKey, undefined];
        const abortSession = abortThreadTs
          ? getThreadSession(abortChannelId, abortThreadTs)
          : getSession(abortChannelId);

        // Compute context% on-the-fly (processingState values may not be computed yet on abort)
        const abortPerTurnTotal = (active.processingState.perTurnInputTokens || 0)
          + (active.processingState.perTurnCacheCreationInputTokens || 0)
          + (active.processingState.perTurnCacheReadInputTokens || 0);
        const abortContextWindow = active.processingState.contextWindow || abortSession?.lastUsage?.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const abortMaxOutput = active.processingState.maxOutputTokens || abortSession?.lastUsage?.maxOutputTokens;
        const abortContextPercent = abortContextWindow && abortPerTurnTotal > 0
          ? Math.min(100, Math.max(0, Number((abortPerTurnTotal / abortContextWindow * 100).toFixed(1))))
          : undefined;
        const abortAutoCompactThreshold = abortContextWindow
          ? computeAutoCompactThreshold(abortContextWindow, abortMaxOutput)
          : undefined;
        const abortCompactPercent = abortAutoCompactThreshold && abortPerTurnTotal > 0
          ? Math.max(0, Number(((abortAutoCompactThreshold - abortPerTurnTotal) / abortAutoCompactThreshold * 100).toFixed(1)))
          : undefined;
        const abortTokensToCompact = abortAutoCompactThreshold && abortPerTurnTotal > 0
          ? Math.max(0, abortAutoCompactThreshold - abortPerTurnTotal)
          : undefined;

        // Flush any pending activity batch before showing aborted state
        if (active.processingState.activityBatch.length > 0 && active.processingState.threadParentTs) {
          const charLimit = active.processingState.charLimit || 500;
          await flushActivityBatch(
            active.processingState,
            client,
            channelId,
            charLimit,
            'complete'
          );
        }

        // Update combined message to aborted state
        try {
          await client.chat.update({
            channel: channelId,
            ts: active.statusMsgTs,
            blocks: buildCombinedStatusBlocks({
              activityLog: active.processingState.activityLog,
              inProgress: false,
              status: 'aborted',
              mode: active.mode,
              model: active.model,
              toolsCompleted: active.processingState.toolsCompleted,
              elapsedMs,
              conversationKey,
              sessionId: active.processingState.sessionId,
              // Include stats if available (SDK may have reported them before abort)
              inputTokens: active.processingState.inputTokens,
              outputTokens: active.processingState.outputTokens,
              contextPercent: abortContextPercent,
              compactPercent: abortCompactPercent,
              tokensToCompact: abortTokensToCompact,
              costUsd: active.processingState.costUsd,
            }),
            text: `${active.model || 'Claude'} | ${active.mode} | aborted`,
          });
        } catch (error) {
          console.error('Error updating to aborted:', error);
        }
      });
    }

    // Clean up active query (abortedQueries cleaned up in finally block of main flow)
    activeQueries.delete(conversationKey);
    busyConversations.delete(conversationKey);

    // Clear pending plan approval state and :eyes: on abort
    const pendingPlan = pendingPlanApprovals.get(conversationKey);
    if (pendingPlan) {
      pendingPlanApprovals.delete(conversationKey);
      try {
        await client.reactions.remove({
          channel: pendingPlan.channelId,
          timestamp: pendingPlan.originalTs,
          name: 'eyes',
        });
      } catch (e) {
        // Ignore - reaction may already be removed
      }
    }
  } else {
    console.log(`No active query found for: ${conversationKey}`);
  }
}

// Handle abort query button (abort during processing) - opens confirmation modal
app.action(/^abort_query_(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging abort query click:', error);
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^abort_query_(.+)$/);
  const conversationKey = match ? match[1] : '';

  console.log(`Abort query clicked for conversation: ${conversationKey}`);

  const bodyWithTrigger = body as any;
  const channelId = bodyWithTrigger.channel?.id;
  const messageTs = bodyWithTrigger.message?.ts;

  if (!bodyWithTrigger.trigger_id || !channelId) {
    console.error('Missing trigger_id or channelId for abort query modal');
    if (channelId && bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
    return;
  }

  try {
    await client.views.open({
      trigger_id: bodyWithTrigger.trigger_id,
      view: buildAbortConfirmationModalView({
        abortType: 'query',
        key: conversationKey,
        channelId,
        messageTs: messageTs || '',
      }),
    });
  } catch (error) {
    console.error('Error opening abort confirmation modal:', error);
    if (bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
  }
});

// Handle "Type something" button - opens modal for free text input
app.action(/^freetext_(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging freetext click:', error);
    // ack() failed but we should still try to open the modal
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^freetext_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`Freetext clicked for question: ${questionId}`);

  const bodyWithTrigger = body as any;
  const triggerId = bodyWithTrigger.trigger_id;

  if (triggerId) {
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: `freetext_modal_${questionId}`,
          title: { type: "plain_text", text: "Your Answer" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "answer_block",
              element: {
                type: "plain_text_input",
                action_id: "answer_input",
                multiline: true,
                placeholder: { type: "plain_text", text: "Type your answer here..." },
              },
              label: { type: "plain_text", text: "Answer" },
            },
          ],
        },
      });
    } catch (error) {
      console.error('Error opening modal:', error);
    }
  }
});

// Handle modal submission for free text answers
app.view(/^freetext_modal_(.+)$/, async ({ ack, body, view, client }) => {
  await ack();

  const callbackId = view.callback_id;
  const match = callbackId.match(/^freetext_modal_(.+)$/);
  const questionId = match ? match[1] : '';

  const answer = view.state.values.answer_block.answer_input.value || '';

  console.log(`Modal submitted for question: ${questionId}, answer: ${answer}`);

  // Write answer to file
  const answerFile = `${ANSWER_DIR}/${questionId}.json`;
  try {
    fs.writeFileSync(answerFile, JSON.stringify({ answer, timestamp: Date.now() }));
    console.log(`Wrote answer file: ${answerFile}`);
  } catch (error) {
    console.error('Error writing answer file:', error);
  }
});

// Handle "Fork to New Channel" modal submission
app.view('fork_to_channel_modal', async ({ ack, body, view, client }) => {
  const channelName = (view.state.values.channel_name_block?.channel_name_input?.value || '').trim();

  // Basic validation - let Slack validate the rest
  if (channelName.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { channel_name_block: 'Channel name is required' },
    });
    return;
  }

  await ack(); // Close modal

  const metadata = JSON.parse(view.private_metadata || '{}');
  const result = await createForkToChannel({
    channelName,
    ...metadata,
    userId: body.user?.id || 'unknown',
    client: client as any,
  });

  if (!result.success) {
    await withSlackRetry(() =>
      (client as any).chat.postMessage({
        channel: metadata.sourceChannelId,
        thread_ts: metadata.threadTs,
        text: `❌ Failed to create fork channel: ${result.error}`,
      })
    );
  }
});

// Handle abort confirmation modal submission
app.view('abort_confirmation_modal', async ({ ack, view, client }) => {
  await ack();

  const metadata = JSON.parse(view.private_metadata || '{}');
  const { abortType, key, channelId, messageTs } = metadata;

  console.log(`Abort confirmation submitted: type=${abortType}, key=${key}`);

  switch (abortType) {
    case 'query':
      await handleQueryAbort(key, channelId, client as WebClient);
      break;
    case 'question':
      await handleQuestionAbort(key, channelId, messageTs, client as WebClient);
      break;
    case 'sdk_question':
      await handleSdkQuestionAbort(key, channelId, messageTs, client as WebClient);
      break;
  }
});

// Handle mode selection buttons (/mode command)
// Matches SDK permission modes: plan, default, bypassPermissions, acceptEdits
app.action(/^mode_(plan|default|bypassPermissions|acceptEdits)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const mode = actionId.replace('mode_', '') as PermissionMode;

  const bodyWithChannel = body as any;
  const channelId = bodyWithChannel.channel?.id;

  console.log(`Mode button clicked: ${mode} for channel: ${channelId}`);

  if (channelId) {
    // Update session with new mode (thread-aware)
    const threadTs = bodyWithChannel.message?.thread_ts;
    if (threadTs) {
      await saveThreadSession(channelId, threadTs, { mode });
    } else {
      await saveSession(channelId, { mode });
    }

    // Live update: If a query is running, update SDK mode immediately
    const conversationKey = getConversationKey(channelId, threadTs);
    const activeQuery = activeQueries.get(conversationKey);
    if (activeQuery) {
      try {
        await activeQuery.query.setPermissionMode(mode);
        activeQuery.mode = mode;
        console.log(`[LiveConfig] Updated active query mode to ${mode} via button`);
      } catch (err) {
        console.error('[LiveConfig] Failed to update mode via button:', err);
      }
    }

    // Update the message to confirm selection
    if (bodyWithChannel.message?.ts) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: bodyWithChannel.message.ts,
          text: `Mode set to \`${mode}\``,
          blocks: [],
        });
      } catch (error) {
        console.error('Error updating mode selection message:', error);
      }
    }
  }
});

// Handle model selection buttons (/model command)
app.action(/^model_select_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const modelId = actionId.replace('model_select_', '');

  const bodyWithChannel = body as typeof body & { channel?: { id: string }; message?: { ts: string; thread_ts?: string } };
  const channelId = bodyWithChannel.channel?.id;
  if (!channelId) return;

  console.log(`Model button clicked: ${modelId} for channel: ${channelId}`);

  // Check if conversation is busy - model changes don't take effect mid-turn
  // so we block them while a query is running to avoid confusion
  const conversationKey = getConversationKey(channelId, bodyWithChannel.message?.thread_ts);
  if (busyConversations.has(conversationKey)) {
    // Update message to show busy error
    if (bodyWithChannel.message?.ts) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: bodyWithChannel.message.ts,
          text: 'Cannot change model while processing',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':warning: Cannot change model while a query is running. Please wait for it to complete or click Abort.',
              },
            },
          ],
        });
      } catch (error) {
        console.error('Error updating model selection message:', error);
      }
    }
    return;
  }

  // Get model display name for confirmation
  const modelInfo = await getModelInfo(modelId);
  const displayName = modelInfo?.displayName || modelId;

  // Save to session (thread-aware)
  const threadTs = bodyWithChannel.message?.thread_ts;
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { model: modelId });
  } else {
    await saveSession(channelId, { model: modelId });
  }

  // Update message to confirm
  if (bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: channelId,
        ts: bodyWithChannel.message.ts,
        text: `Model set to *${displayName}*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: Model set to *${displayName}*\n\`${modelId}\``,
            },
          },
        ],
      });
    } catch (error) {
      console.error('Error updating model selection message:', error);
    }
  }
});

// ============================================================================
// Plan Approval Handlers (5 options matching CLI)
// ============================================================================

// Helper to extract conversation key from action_id
function extractPlanApprovalConversationKey(action: any, pattern: RegExp): string {
  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(pattern);
  return match ? match[1] : '';
}

// Helper to update approval message
async function updateApprovalMessage(body: any, client: any, text: string): Promise<void> {
  const bodyWithChannel = body as any;
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating plan approval message:', error);
    }
  }
}

// Option 1: Clear context and bypass permissions
app.action(/^plan_clear_bypass_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_clear_bypass_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  // Clear pending plan approval state and :eyes:
  const pending = pendingPlanApprovals.get(conversationKey);
  if (pending) {
    pendingPlanApprovals.delete(conversationKey);
    busyConversations.delete(conversationKey);
    try {
      await client.reactions.remove({
        channel: pending.channelId,
        timestamp: pending.originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
  }

  console.log(`Plan option 1 (clear + bypass) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Clearing context and proceeding with bypass mode...');

  // Get plan file path before clearing (from activeQuery's processingState)
  const activeQuery = activeQueries.get(conversationKey);
  let planFilePath = activeQuery?.processingState?.planFilePath;

  // Fallback: read from persisted session if activeQuery cleanup already happened
  if (!planFilePath) {
    const session = threadTs
      ? getThreadSession(channelId, threadTs)
      : getSession(channelId);
    planFilePath = session?.planFilePath || null;
  }

  // Clear session (set sessionId to null) and set bypass mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { sessionId: null, mode: 'bypassPermissions' });
  } else {
    await saveSession(channelId, { sessionId: null, mode: 'bypassPermissions' });
  }

  const bodyWithChannel = body as any;
  // Get effective thread from button message context (button is already in a thread)
  const effectiveThreadTs = threadTs || bodyWithChannel.message?.thread_ts || bodyWithChannel.message?.ts;

  // Build activity log with context_cleared and mode_changed entries
  let activityLog = pending?.activityLog ? [...pending.activityLog] : [];
  activityLog.push({ timestamp: Date.now(), type: 'context_cleared' });
  activityLog.push({ timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' });

  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: planFilePath
      ? `Execute the plan at ${planFilePath}`
      : 'Yes, proceed with the plan.',
    originalTs: effectiveThreadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
    statusMsgTs: pending?.statusMsgTs,
    activityLog,
  });
});

// Option 2: Accept edits (auto-accept code edits only)
app.action(/^plan_accept_edits_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_accept_edits_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  // Clear pending plan approval state and :eyes:
  const pending = pendingPlanApprovals.get(conversationKey);
  if (pending) {
    pendingPlanApprovals.delete(conversationKey);
    busyConversations.delete(conversationKey);
    try {
      await client.reactions.remove({
        channel: pending.channelId,
        timestamp: pending.originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
  }

  console.log(`Plan option 2 (accept edits) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with accept-edits mode...');

  // Set acceptEdits mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'acceptEdits' });
  } else {
    await saveSession(channelId, { mode: 'acceptEdits' });
  }

  const bodyWithChannel = body as any;
  // Get effective thread from button message context (button is already in a thread)
  const effectiveThreadTs = threadTs || bodyWithChannel.message?.thread_ts || bodyWithChannel.message?.ts;

  // Build activity log with mode_changed entry (plan → acceptEdits)
  let activityLog = pending?.activityLog ? [...pending.activityLog] : [];
  activityLog.push({ timestamp: Date.now(), type: 'mode_changed', mode: 'acceptEdits' });

  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: effectiveThreadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
    statusMsgTs: pending?.statusMsgTs,
    activityLog,
  });
});

// Option 3: Bypass permissions (auto-accept all)
app.action(/^plan_bypass_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_bypass_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  // Clear pending plan approval state and :eyes:
  const pending = pendingPlanApprovals.get(conversationKey);
  if (pending) {
    pendingPlanApprovals.delete(conversationKey);
    busyConversations.delete(conversationKey);
    try {
      await client.reactions.remove({
        channel: pending.channelId,
        timestamp: pending.originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
  }

  console.log(`Plan option 3 (bypass) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with bypass mode...');

  // Set bypassPermissions mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'bypassPermissions' });
  } else {
    await saveSession(channelId, { mode: 'bypassPermissions' });
  }

  const bodyWithChannel = body as any;
  // Get effective thread from button message context (button is already in a thread)
  const effectiveThreadTs = threadTs || bodyWithChannel.message?.thread_ts || bodyWithChannel.message?.ts;

  // Build activity log with mode_changed entry (plan → bypassPermissions)
  let activityLog = pending?.activityLog ? [...pending.activityLog] : [];
  activityLog.push({ timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' });

  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: effectiveThreadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
    statusMsgTs: pending?.statusMsgTs,
    activityLog,
  });
});

// Option 4: Manual approve (ask for each tool)
app.action(/^plan_manual_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_manual_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  // Clear pending plan approval state and :eyes:
  const pending = pendingPlanApprovals.get(conversationKey);
  if (pending) {
    pendingPlanApprovals.delete(conversationKey);
    busyConversations.delete(conversationKey);
    try {
      await client.reactions.remove({
        channel: pending.channelId,
        timestamp: pending.originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
  }

  console.log(`Plan option 4 (manual) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with manual approval mode...');

  // Set default (ask) mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'default' });
  } else {
    await saveSession(channelId, { mode: 'default' });
  }

  const bodyWithChannel = body as any;
  // Get effective thread from button message context (button is already in a thread)
  const effectiveThreadTs = threadTs || bodyWithChannel.message?.thread_ts || bodyWithChannel.message?.ts;

  // Build activity log with mode_changed entry (plan → default)
  let activityLog = pending?.activityLog ? [...pending.activityLog] : [];
  activityLog.push({ timestamp: Date.now(), type: 'mode_changed', mode: 'default' });

  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: effectiveThreadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
    statusMsgTs: pending?.statusMsgTs,
    activityLog,
  });
});

// Option 5: Reject/Change the plan
app.action(/^plan_reject_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_reject_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  // Clear pending plan approval state and :eyes:
  const pending = pendingPlanApprovals.get(conversationKey);
  if (pending) {
    pendingPlanApprovals.delete(conversationKey);
    busyConversations.delete(conversationKey);
    try {
      await client.reactions.remove({
        channel: pending.channelId,
        timestamp: pending.originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
  }

  console.log(`Plan option 5 (reject/change) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '❌ Plan rejected. Tell Claude what to change.');

  // Keep mode as plan, send rejection message to Claude
  const bodyWithChannel = body as any;
  // Get effective thread from button message context (button is already in a thread)
  const effectiveThreadTs = threadTs || bodyWithChannel.message?.thread_ts || bodyWithChannel.message?.ts;

  // Reuse activity log (no mode_changed since staying in plan mode)
  const activityLog = pending?.activityLog ? [...pending.activityLog] : [];

  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'No, I want to change the plan. Please wait for my feedback.',
    originalTs: effectiveThreadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
    statusMsgTs: pending?.statusMsgTs,
    activityLog,
  });
});

// Handle tool approval "Approve" button (for manual approval mode)
app.action(/^tool_approve_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^tool_approve_(.+)$/);
  const approvalId = match ? match[1] : '';

  console.log(`Tool approve clicked for: ${approvalId}`);

  const pending = pendingToolApprovals.get(approvalId);
  if (pending) {
    // Clear reminder interval
    clearToolApprovalReminder(approvalId);
    pendingToolApprovals.delete(approvalId);

    // Update message to show approved
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: `✅ Approved: \`${pending.toolName}\``,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating tool approval message:', error);
    }

    // Resolve the promise to allow tool execution
    // SDK requires updatedInput field (pass through original input)
    console.log(`Resolving tool approval with allow for ${pending.toolName}`);
    pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
    console.log(`Tool approval resolved for: ${approvalId}`);
  } else {
    console.log(`No pending approval found for: ${approvalId}`);
  }
});

// Handle tool approval "Deny" button (for manual approval mode)
app.action(/^tool_deny_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^tool_deny_(.+)$/);
  const approvalId = match ? match[1] : '';

  console.log(`Tool deny clicked for: ${approvalId}`);

  const pending = pendingToolApprovals.get(approvalId);
  if (pending) {
    // Clear reminder interval
    clearToolApprovalReminder(approvalId);
    pendingToolApprovals.delete(approvalId);

    // Update message to show denied
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: `❌ Denied: \`${pending.toolName}\``,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating tool denial message:', error);
    }

    // Resolve the promise to deny tool execution
    // SDK requires message field
    pending.resolve({ behavior: 'deny', message: 'User denied this tool use' });
  } else {
    console.log(`No pending approval found for: ${approvalId}`);
  }
});

// Handle SDK AskUserQuestion option button click
app.action(/^sdkq_(.+)_(\d+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question option click:', error);
    // ack() failed but we should still try to process the answer
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_(.+)_(\d+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question option clicked for: ${questionId}`);

  const pending = pendingSdkQuestions.get(questionId);
  if (pending) {
    const answer = 'value' in action ? (action.value as string) : '';

    // Clear reminder
    clearToolApprovalReminder(questionId);
    pendingSdkQuestions.delete(questionId);

    // Update message to show answered state
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: `Answered: ${answer}`,
        blocks: buildAnsweredBlocks(pending.question, answer),
      });
    } catch (error) {
      console.error('Error updating SDK question message:', error);
    }

    pending.resolve(answer);
  } else {
    console.log(`No pending SDK question found for: ${questionId}`);
  }
});

// Handle SDK AskUserQuestion multi-select change
app.action(/^sdkq_multi_(.+)$/, async ({ action, ack }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question multi-select change:', error);
    // ack() failed but we should still try to store the selection
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_multi_(.+)$/);
  const questionId = match ? match[1] : '';

  // Store selected options for later submission
  if ('selected_options' in action && Array.isArray((action as any).selected_options)) {
    const selections = (action as any).selected_options.map((opt: any) => opt.value as string);
    pendingSdkMultiSelections.set(questionId, selections);
    console.log(`SDK question multi-select updated for ${questionId}: ${selections.join(', ')}`);
  }
});

// Handle SDK AskUserQuestion multi-select submit
app.action(/^sdkq_submit_(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question submit:', error);
    // ack() failed but we should still try to process the submission
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_submit_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question submit clicked for: ${questionId}`);

  const pending = pendingSdkQuestions.get(questionId);
  if (pending) {
    // Get selections from pending map
    const selections = pendingSdkMultiSelections.get(questionId) || [];
    const answer = selections.join(', ') || '(no selection)';

    // Clean up
    clearToolApprovalReminder(questionId);
    pendingSdkQuestions.delete(questionId);
    pendingSdkMultiSelections.delete(questionId);

    // Update message to show answered state
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: `Answered: ${answer}`,
        blocks: buildAnsweredBlocks(pending.question, answer),
      });
    } catch (error) {
      console.error('Error updating SDK question message:', error);
    }

    pending.resolve(answer);
  } else {
    console.log(`No pending SDK question found for: ${questionId}`);
  }
});

// Helper function to execute SDK question abort logic (called from modal submission)
async function handleSdkQuestionAbort(questionId: string, channelId: string, messageTs: string, client: WebClient): Promise<void> {
  console.log(`Aborting SDK question: ${questionId}`);

  const pending = pendingSdkQuestions.get(questionId);
  if (pending) {
    // Clean up
    clearToolApprovalReminder(questionId);
    pendingSdkQuestions.delete(questionId);
    pendingSdkMultiSelections.delete(questionId);

    // Update message to show aborted
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: 'Question aborted',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Question:* ${pending.question}\n*Status:* _Aborted_`,
            },
          },
        ],
      });
    } catch (error) {
      console.error('Error updating aborted SDK question message:', error);
    }

    pending.resolve('__ABORTED__');
  } else {
    console.log(`No pending SDK question found for: ${questionId}`);
  }
}

// Handle SDK AskUserQuestion abort button - opens confirmation modal
app.action(/^sdkq_abort_(.+)$/, async ({ action, ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question abort:', error);
  }

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_abort_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question abort clicked for: ${questionId}`);

  const bodyWithTrigger = body as any;
  const channelId = bodyWithTrigger.channel?.id;
  const messageTs = bodyWithTrigger.message?.ts;

  if (!bodyWithTrigger.trigger_id || !channelId) {
    console.error('Missing trigger_id or channelId for SDK abort modal');
    if (channelId && bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
    return;
  }

  try {
    await client.views.open({
      trigger_id: bodyWithTrigger.trigger_id,
      view: buildAbortConfirmationModalView({
        abortType: 'sdk_question',
        key: questionId,
        channelId,
        messageTs: messageTs || '',
      }),
    });
  } catch (error) {
    console.error('Error opening abort confirmation modal:', error);
    if (bodyWithTrigger.user?.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithTrigger.user.id,
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    }
  }
});

// Handle SDK AskUserQuestion "Other" button (free-text input)
app.action(/^sdkq_other_(.+)$/, async ({ ack, body, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question other click:', error);
    // ack() failed but we should still try to open the modal
  }

  const bodyWithTrigger = body as any;
  const actionId = bodyWithTrigger.actions?.[0]?.action_id || '';
  const match = actionId.match(/^sdkq_other_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question other clicked for: ${questionId}`);

  const pending = pendingSdkQuestions.get(questionId);
  if (pending && bodyWithTrigger.trigger_id) {
    // Open modal for free-text input
    try {
      await client.views.open({
        trigger_id: bodyWithTrigger.trigger_id,
        view: {
          type: 'modal',
          callback_id: `sdkq_freetext_modal_${questionId}`,
          title: { type: 'plain_text', text: 'Your Answer' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Question:* ${pending.question}` },
            },
            {
              type: 'input',
              block_id: 'answer_block',
              element: {
                type: 'plain_text_input',
                action_id: 'answer_input',
                multiline: true,
                placeholder: { type: 'plain_text', text: 'Type your answer...' },
              },
              label: { type: 'plain_text', text: 'Your answer' },
            },
          ],
        },
      });
    } catch (error) {
      console.error('Error opening free-text modal:', error);
    }
  }
});

// Handle SDK AskUserQuestion free-text modal submission
app.view(/^sdkq_freetext_modal_(.+)$/, async ({ ack, body, view, client }) => {
  try {
    await ack();
  } catch (error) {
    console.error('Error acknowledging SDK question free-text modal:', error);
    // ack() failed but we should still try to process the answer
  }

  const callbackId = view.callback_id;
  const match = callbackId.match(/^sdkq_freetext_modal_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question free-text submitted for: ${questionId}`);

  const pending = pendingSdkQuestions.get(questionId);
  if (pending) {
    const answer = view.state.values.answer_block?.answer_input?.value || '';

    // Clean up
    clearToolApprovalReminder(questionId);
    pendingSdkQuestions.delete(questionId);

    // Update original message to show answered state
    try {
      await client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: `Answered: ${answer}`,
        blocks: buildAnsweredBlocks(pending.question, answer),
      });
    } catch (error) {
      console.error('Error updating SDK question message:', error);
    }

    pending.resolve(answer);
  }
});

// Handle concurrent session cancel button
app.action(/^concurrent_cancel_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^concurrent_cancel_(.+)$/);
  const sessionId = match ? match[1] : '';

  console.log(`Concurrent cancel clicked for session: ${sessionId}`);

  // Remove pending message
  const bodyWithChannel = body as any;
  const channelId = bodyWithChannel.channel?.id;
  if (channelId) {
    pendingMessages.delete(`${channelId}_${sessionId}`);
  }

  // Update message to show cancelled
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    await client.chat.update({
      channel: bodyWithChannel.channel.id,
      ts: bodyWithChannel.message.ts,
      text: `Request cancelled. Continue in terminal with: \`claude --resume ${sessionId}\``,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Cancelled.* Continue in terminal with:\n\`\`\`claude --resume ${sessionId}\`\`\``,
          },
        },
      ],
    });
  }
});

// Handle concurrent session proceed button
app.action(/^concurrent_proceed_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^concurrent_proceed_(.+)$/);
  const sessionId = match ? match[1] : '';

  console.log(`Concurrent proceed clicked for session: ${sessionId}`);

  const bodyWithChannel = body as any;
  const channelId = bodyWithChannel.channel?.id;

  // Get and remove pending message
  const pendingKey = `${channelId}_${sessionId}`;
  const pending = pendingMessages.get(pendingKey);
  pendingMessages.delete(pendingKey);

  // Update warning message
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    await client.chat.update({
      channel: bodyWithChannel.channel.id,
      ts: bodyWithChannel.message.ts,
      text: `Proceeding despite concurrent session...`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Proceeding...* Note: This may cause conflicts with the terminal session.`,
          },
        },
      ],
    });
  }

  // Process the pending message if we have it
  if (pending && channelId) {
    await handleMessage({
      channelId: pending.channelId,
      userId: pending.userId,
      userText: pending.userText,
      originalTs: pending.originalTs,
      threadTs: pending.threadTs,
      client,
      skipConcurrentCheck: true, // Skip the check on retry
    });
  }
});

// ============================================================================
// Fork Here Handler
// ============================================================================

// Handle "Fork here" button click - opens modal for new channel creation
app.action(/^fork_here_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  // Extract conversationKey from action_id
  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^fork_here_(.+)$/);
  const conversationKey = match ? match[1] : '';

  // Get messageTs from the message the button is on (Slack provides this)
  const bodyWithMessage = body as any;
  const messageTs = bodyWithMessage.message?.ts;
  const triggerId = bodyWithMessage.trigger_id;

  if (!messageTs || !triggerId) {
    console.error('[ForkHere] Could not get message timestamp or trigger_id from body');
    return;
  }

  // Parse { threadTs, sdkMessageId, sessionId } from action.value
  const valueStr = 'value' in action ? (action.value || '{}') : '{}';
  let forkInfo: { threadTs?: string; sdkMessageId?: string; sessionId?: string };
  try {
    forkInfo = JSON.parse(valueStr);
  } catch {
    console.error('[ForkHere] Invalid forkInfo JSON:', valueStr);
    return;
  }

  // Derive channelId from conversationKey (format: channelId or channelId_threadTs)
  const channelId = conversationKey.split('_')[0];

  // Get current channel name and find next available fork name
  let suggestedName = '';
  try {
    const channelInfo = await (client as any).conversations.info({ channel: channelId });
    if (channelInfo.ok && channelInfo.channel?.name) {
      const baseForkName = `${channelInfo.channel.name}-fork`;

      // List channels to find existing forks with this pattern
      const existingNames = new Set<string>();
      let cursor: string | undefined;
      do {
        const listResult = await (client as any).conversations.list({
          types: 'public_channel,private_channel',
          limit: 200,
          cursor,
        });
        if (listResult.ok && listResult.channels) {
          for (const ch of listResult.channels) {
            if (ch.name?.startsWith(baseForkName)) {
              existingNames.add(ch.name);
            }
          }
        }
        cursor = listResult.response_metadata?.next_cursor;
      } while (cursor);

      // Find next available name
      if (!existingNames.has(baseForkName)) {
        suggestedName = baseForkName;
      } else {
        // Find next available number
        let num = 1;
        while (existingNames.has(`${baseForkName}-${num}`)) {
          num++;
        }
        suggestedName = `${baseForkName}-${num}`;
      }
    }
  } catch (error) {
    // Ignore - just won't prefill
    console.log('[ForkHere] Could not get channel name for prefill:', error);
  }

  // Open modal for channel name input
  try {
    await (client as any).views.open({
      trigger_id: triggerId,
      view: buildForkToChannelModalView({
        sourceChannelId: channelId,
        sourceMessageTs: messageTs,
        conversationKey,
        threadTs: forkInfo.threadTs,
        sdkMessageId: forkInfo.sdkMessageId,
        sessionId: forkInfo.sessionId,
        suggestedChannelName: suggestedName,
      }),
    });
  } catch (error) {
    console.error('[ForkHere] Error opening modal:', error);
  }
});

// Handle "Refresh fork" button click - restore Fork here if forked channel was deleted
app.action(/^refresh_fork_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const bodyWithMessage = body as any;
  const channelId = bodyWithMessage.channel?.id;
  const messageTs = bodyWithMessage.message?.ts;

  if (!channelId || !messageTs) {
    console.error('[RefreshFork] Missing channel or message info');
    return;
  }

  // Parse fork info from button value
  const valueStr = 'value' in action ? (action.value || '{}') : '{}';
  let forkInfo: {
    forkChannelId?: string;
    threadTs?: string;
    sdkMessageId?: string;
    sessionId?: string;
    conversationKey?: string;
  };
  try {
    forkInfo = JSON.parse(valueStr);
  } catch {
    console.error('[RefreshFork] Invalid button value');
    return;
  }

  // Check if forked channel still exists
  if (forkInfo.forkChannelId) {
    try {
      await (client as any).conversations.info({ channel: forkInfo.forkChannelId });
      // Channel exists, do nothing
      console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} still exists, no action needed`);
      return;
    } catch (error: any) {
      // Channel doesn't exist (deleted) - proceed to restore Fork here
      console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} not found, restoring Fork here button`);
    }
  }

  // Restore Fork here button
  await restoreForkHereButton(client, {
    sourceChannelId: channelId,
    sourceMessageTs: messageTs,
    threadTs: forkInfo.threadTs,
    sdkMessageId: forkInfo.sdkMessageId,
    sessionId: forkInfo.sessionId,
    conversationKey: forkInfo.conversationKey,
  });
});

// Handle "Generate Output" retry button click when upload failed
// Note: This feature requires activity log persistence which has been removed.
// This handler exists for backwards compatibility with old messages that may have the button.
app.action(/^retry_upload_(.+)$/, async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel?.id;
  const userId = body.user?.id;

  if (!channelId || !userId) return;

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: ':warning: Response content is no longer available. Activity logs are not persisted.',
  });
});

// Handle "Attach Response" retry button click for thinking file upload
// Reads thinking content from session file and retries upload with cross-linking
app.action(/^attach_thinking_file_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const channelId = body.channel?.id;
  const userId = body.user?.id;
  const activityMsgTs = (body as any).message?.ts;

  if (!channelId || !userId || !activityMsgTs) return;

  try {
    // Parse button value to get session info
    const value = JSON.parse((action as any).value);
    const { threadParentTs, sessionId, thinkingTimestamp, thinkingCharCount } = value;

    if (!sessionId || !threadParentTs) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Missing session info. Cannot retry upload.',
      });
      return;
    }

    // Get working directory from session
    const session = getSession(channelId);
    const workingDir = session?.workingDir || process.cwd();

    // 1. Read thinking content from session file (match by timestamp + charCount)
    const thinkingContent = await getThinkingContentFromSession(
      sessionId,
      thinkingTimestamp,
      thinkingCharCount,
      workingDir
    );

    if (!thinkingContent) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Could not retrieve thinking content from session. The session file may have been cleared or the content is no longer available.',
      });
      return;
    }

    // 2. Get permalink to thinking message (for file back-link)
    const thinkingMsgLink = await getMessagePermalink(client, channelId, activityMsgTs);

    // 3. Upload files with back-link
    const uploadResult = await uploadFilesToThread(
      client,
      channelId,
      threadParentTs,
      thinkingContent,
      `_Content for <${thinkingMsgLink}|this thinking block>._`,
      userId
    );

    if (uploadResult.success && uploadResult.fileMessageTs) {
      // 4. Get permalink to file message (for forward-link)
      const fileMsgLink = await getMessagePermalink(client, channelId, uploadResult.fileMessageTs);

      // 5. Update thinking message: remove button, add link suffix
      const currentBlocks = (body as any).message?.blocks || [];
      const textBlock = currentBlocks.find((b: any) => b.type === 'section');
      const baseText = textBlock?.text?.text || '';
      const newText = `${baseText}\n_Full response <${fileMsgLink}|attached>._`;

      await client.chat.update({
        channel: channelId,
        ts: activityMsgTs,
        text: newText,
        blocks: undefined,  // Remove button by clearing blocks
      });

      console.log(`[attach_thinking_file] Successfully uploaded and cross-linked: ${uploadResult.fileMessageTs}`);
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Failed to attach file. Please try again.',
      });
    }
  } catch (error) {
    console.error('[attach_thinking_file] Handler error:', error);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: ':warning: An error occurred while attaching the file.',
    });
  }
});

// Handle "Stop Watching" button click for terminal session watcher
app.action('stop_terminal_watch', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel?.id;
  if (!channelId) return;

  const bodyWithMessage = body as any;

  // Get threadTs from button value (for thread-based output where anchor has the button)
  // Falls back to message's thread_ts for backwards compatibility
  let threadTs: string | undefined;
  try {
    const buttonValue = JSON.parse(bodyWithMessage.actions?.[0]?.value || '{}');
    threadTs = buttonValue.threadTs;
  } catch {
    // Fallback to message's thread_ts
    threadTs = bodyWithMessage.message?.thread_ts;
  }

  const stopped = stopWatching(channelId, threadTs);
  // Remove from busy state when watcher stops
  // Always use channelId only since /watch is main-channel-only
  busyConversations.delete(channelId);

  if (stopped && bodyWithMessage.message?.ts) {
    // Update the message to show stopped state
    try {
      await client.chat.update({
        channel: channelId,
        ts: bodyWithMessage.message.ts,
        text: 'Terminal watching stopped',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: ':white_check_mark: Stopped watching terminal session.' },
        }],
      });
    } catch (error) {
      console.error('[StopWatch] Failed to update message:', error);
    }
  }
});

// Handle "Stop FF" button click for fast-forward sync
app.action('stop_ff_sync', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel?.id;
  if (!channelId) return;

  // Get threadTs from message if in thread
  const bodyWithMessage = body as any;
  const threadTs = bodyWithMessage.message?.thread_ts;

  // Mark sync as aborted
  const conversationKey = threadTs ? `${channelId}_${threadTs}` : channelId;
  markFfAborted(conversationKey);
  console.log(`[StopFF] User requested stop for ${conversationKey}`);

  // Update message to show stopping state (actual stop message is handled by the sync loop)
  if (bodyWithMessage.message?.ts) {
    try {
      await client.chat.update({
        channel: channelId,
        ts: bodyWithMessage.message.ts,
        text: 'Stopping sync...',
        blocks: [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: ':hourglass: Stopping sync... (will stop after current message completes)',
          }],
        }],
      });
    } catch (error) {
      console.error('[StopFF] Failed to update message:', error);
    }
  }
});

export async function startBot() {
  // Refresh model cache on startup
  console.log('Refreshing model cache...');
  await refreshModelCache();

  await app.start();
  console.log('Bot is running!');
}

// Exported for testing
export { getThinkingContentFromSession, updateThinkingMessageWithRetry };
