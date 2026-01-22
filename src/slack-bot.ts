import { App } from '@slack/bolt';
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
  saveActivityLog,
  getActivityLog,
  clearSyncedMessageUuids,
  addSlackOriginatedUserUuid,
  generateSegmentKey,
  saveSegmentActivityLog,
  getSegmentActivityLog,
  updateSegmentActivityLog,
  clearSegmentActivityLogs,
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
  buildActivityLogModalView,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
  buildStatusDisplayBlocks,
  buildSdkQuestionBlocks,
  buildAnsweredBlocks,
  buildStopWatchingButton,
} from './blocks.js';
import {
  getAvailableModels,
  isModelAvailable,
  refreshModelCache,
  getModelInfo,
} from './model-cache.js';
import { uploadMarkdownAndPngWithResponse } from './streaming.js';
import { markAborted, isAborted, clearAborted } from './abort-tracker.js';
import { markFfAborted, isFfAborted, clearFfAborted } from './ff-abort-tracker.js';
import { markdownToSlack, formatTimeRemaining, stripMarkdownCodeFence } from './utils.js';
import { parseCommand, UPDATE_RATE_DEFAULT } from './commands.js';
import { toUserMessage, SlackBotError, Errors } from './errors.js';
import { withSlackRetry } from './retry.js';
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
} from './session-reader.js';
import { syncMessagesFromOffset, MessageSyncState } from './message-sync.js';
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
  contextWindow?: number;
  costUsd?: number;
  durationMs?: number;
  // Rate limit tracking
  rateLimitHits: number;
  rateLimitNotified: boolean;
  // Auto-compact tracking
  autoCompactNotified: boolean;
  // ExitPlanMode tool tracking (for CLI-fidelity plan approval)
  exitPlanModeIndex: number | null;
  exitPlanModeInputJson: string;
  exitPlanModeInput: ExitPlanModeInput | null;
  // File tool tracking (Write, Edit, Read) to capture plan file path
  fileToolInputs: Map<number, string>;  // Tracks by tool index
  planFilePath: string | null;
  // Segment tracking for View Log isolation
  currentSegmentKey: string | null;
  lastPostedActivityIndex: number;
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
const busyConversations = new Set<string>();

// Track active queries for abort capability
interface ActiveQuery {
  query: ClaudeQuery;
  statusMsgTs: string;           // Combined message: Activity log + Status panel
  mode: PermissionMode;
  model?: string;
  processingState: ProcessingState;
}
const activeQueries = new Map<string, ActiveQuery>();

// Mutexes for serializing updates (prevents abort race conditions)
const updateMutexes = new Map<string, Mutex>();

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

// Map from segmentKey -> conversationKey for in-progress segment lookup
// This allows View Log handler to find segment activity during processing
const segmentToConversationKey = new Map<string, string>();

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
    threadCharLimit: session?.threadCharLimit ?? 500,
    stripEmptyTag: session?.stripEmptyTag ?? false,
  };
}

// Helper to check if conversation is busy and respond if so
// Returns true if busy (caller should return early), false if not busy
async function checkBusyAndRespond(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  conversationKey: string
): Promise<boolean> {
  if (busyConversations.has(conversationKey)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I'm busy with the current request. Please wait for it to complete, or click Abort.",
    });
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
 * Compact session - reduces context size by summarizing conversation
 * Sends /compact as prompt to resumed session and tracks progress
 */
async function runCompactSession(
  client: any,
  channelId: string,
  threadTs: string | undefined,
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
      thread_ts: threadTs,
      blocks: buildStatusPanelBlocks({
        status: 'thinking',
        mode: session.mode,
        model: session.model,
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey: `compact_${channelId}`,
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

  // Track compaction state
  let compactBoundaryFound = false;
  let preTokens: number | undefined;
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
            conversationKey: `compact_${channelId}`,
            spinner: SPINNER_FRAMES[spinnerIndex],
            customStatus: compactBoundaryFound ? 'Finalizing...' : 'Compacting session...',
          }),
          text: 'Compacting session...',
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
        console.log(`[Compact] New session: ${newSessionId}, model: ${modelName}`);
      }

      // Capture compact_boundary message
      if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
        compactBoundaryFound = true;
        const metadata = (msg as any).compact_metadata;
        if (metadata) {
          preTokens = metadata.pre_tokens;
          console.log(`[Compact] Boundary found - pre_tokens: ${preTokens}`);
        }
      }

      // Check for compacting status
      if ((msg as any).status === 'compacting') {
        console.log('[Compact] Compacting status received');
      }
    }
  } catch (err: any) {
    errorOccurred = true;
    errorMessage = err.message || String(err);
    console.error(`[Compact] Error: ${errorMessage}`);
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
          conversationKey: `compact_${channelId}`,
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
    const tokenInfo = preTokens
      ? `Tokens before: ${preTokens.toLocaleString()}`
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
          conversationKey: `compact_${channelId}`,
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
          conversationKey: `compact_${channelId}`,
          customStatus: 'Compaction processed',
        }),
        text: 'Compaction processed',
      })
    );
  }
}

/**
 * Clear session - clears conversation history and starts fresh
 * Sends /clear as prompt to resumed session and tracks progress
 */
async function runClearSession(
  client: any,
  channelId: string,
  threadTs: string | undefined,
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
      thread_ts: threadTs,
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
    onSessionCleared(channelId, threadTs);

    // Clear synced message UUIDs (for /ff resumability)
    await clearSyncedMessageUuids(channelId, threadTs);

    // Clear segment activity logs (for View Log isolation)
    clearSegmentActivityLogs(channelId, threadTs);

    // Clean up segment-to-conversation lookup map
    const conversationKey = threadTs ? `${channelId}_${threadTs}` : channelId;
    for (const [segKey, convKey] of segmentToConversationKey.entries()) {
      if (convKey === conversationKey) {
        segmentToConversationKey.delete(segKey);
      }
    }

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
      thread_ts: threadTs,
      text: `:wastebasket: *Session history cleared*\nStarting fresh. Your next message begins a new conversation.\nDuration: ${(elapsed / 1000).toFixed(1)}s`,
    });

    // Show current configuration after clear
    const updatedSession = getSession(channelId);
    if (updatedSession) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
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
 * - Progress updates: shows sync progress to user
 */
async function handleFastForwardSync(
  client: any,
  channelId: string,
  threadTs: string | undefined,
  session: Session,
  userId?: string
): Promise<void> {
  // Get effective session (thread session if in thread)
  const effectiveSession = threadTs
    ? getThreadSession(channelId, threadTs) ?? session
    : session;

  const sessionId = effectiveSession.sessionId;
  const conversationKey = threadTs ? `${channelId}_${threadTs}` : channelId;

  // Clear any previous abort flag
  clearFfAborted(conversationKey);

  if (!sessionId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':warning: No active session. Start a conversation first.',
    });
    return;
  }

  // Check if session file exists
  if (!sessionFileExists(sessionId, effectiveSession.workingDir)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':warning: Session file not found. The session may have been deleted.',
    });
    return;
  }

  // Post initial status message
  const statusMsg = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':fast_forward: Syncing terminal messages...',
    })
  );
  const statusMsgTs = (statusMsg as { ts?: string }).ts!;

  try {
    // 1. Prepare sync state
    const filePath = getSessionFilePath(sessionId, effectiveSession.workingDir);
    const syncState: MessageSyncState = {
      conversationKey,
      channelId,
      threadTs,
      sessionId,
      workingDir: effectiveSession.workingDir,
      client,
    };

    // Create WatchState for postTerminalMessage callback
    const watchState: WatchState = {
      conversationKey,
      channelId,
      threadTs,
      sessionId,
      workingDir: effectiveSession.workingDir,
      fileOffset: 0,  // Not used for posting
      intervalId: null as any,  // Not used for posting
      statusMsgTs,
      client,
      updateRateMs: (effectiveSession.updateRateSeconds ?? 2) * 1000,
      userId,
      activityMessages: new Map(),  // Track activity ts during sync (update-in-place)
    };

    // Track current status message ts (will change as we move it to bottom)
    let currentStatusMsgTs = statusMsgTs;
    let lastReportedTotal = 0;

    // Helper to build progress blocks
    const buildProgressBlocks = (current: number, total: number) => [
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `:fast_forward: Syncing terminal messages... ${current}/${total}`,
        }],
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

    // Helper to move status message to bottom (delete old, post new)
    const moveStatusToBottom = async (current: number, total: number): Promise<void> => {
      // Delete old status message
      try {
        await client.chat.delete({
          channel: channelId,
          ts: currentStatusMsgTs,
        });
      } catch (error) {
        // Ignore delete errors (message may already be deleted)
        console.log(`[FastForward] Could not delete old status message: ${error}`);
      }

      // Post new status message at bottom
      try {
        const result = await withSlackRetry(() =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `:fast_forward: Syncing terminal messages... ${current}/${total}`,
            blocks: buildProgressBlocks(current, total),
          })
        );
        const newTs = (result as { ts?: string }).ts;
        if (newTs) {
          currentStatusMsgTs = newTs;
        }
      } catch (error) {
        console.error(`[FastForward] Failed to post new status message:`, error);
      }
    };

    // 2. Run sync with progress tracking
    const syncResult = await syncMessagesFromOffset(syncState, filePath, 0, {
      infiniteRetry: true,
      isAborted: () => isFfAborted(conversationKey),
      pacingDelayMs: FF_PACING_DELAY_MS,
      postTextMessage: (s, msg) => postTerminalMessage(watchState, msg),
      activityMessages: watchState.activityMessages,  // Pass activity ts map for update-in-place
      onProgress: async (synced, total) => {
        lastReportedTotal = total;
        // Update initial status on first message
        if (synced === 1) {
          await withSlackRetry(() =>
            client.chat.update({
              channel: channelId,
              ts: currentStatusMsgTs,
              text: `:fast_forward: Syncing ${total} message(s) from terminal...`,
              blocks: buildProgressBlocks(synced, total),
            })
          );
        }
        // Move status message to bottom every 10 messages or on last message
        if (synced % 10 === 0 || synced === total) {
          await moveStatusToBottom(synced, total);
        }
      },
    });

    // Clear abort flag
    clearFfAborted(conversationKey);

    // 3. Handle "already up to date" case
    if (syncResult.totalToSync === 0) {
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: statusMsgTs,
          text: ':white_check_mark: Already up to date. No new terminal messages to sync.',
        })
      );

      // Still start watching - show terminal command like /watch does
      const updateRate = effectiveSession.updateRateSeconds ?? 2;
      const terminalCommand = `cd ${effectiveSession.workingDir} && claude --dangerously-skip-permissions --resume ${sessionId}`;
      const watchStatusMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Continue in Terminal: ${terminalCommand}`,
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
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `:eye: Watching for terminal activity... Updates every ${updateRate}s`,
            }],
          },
          buildStopWatchingButton(sessionId),
        ],
      });
      startWatching(channelId, threadTs, effectiveSession as Session, client, watchStatusMsg.ts as string, userId);
      return;
    }

    // Use tracked values for completion message
    const totalToSync = lastReportedTotal || syncResult.totalToSync;
    const syncedCount = syncResult.syncedCount;
    const wasStopped = syncResult.wasAborted;

    // 8. Update status to show completion or stopped
    if (wasStopped) {
      const remaining = totalToSync - syncedCount;
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: currentStatusMsgTs,
          text: `:stop_sign: Sync stopped. Synced ${syncedCount}/${totalToSync} message(s). Run \`/ff\` again to continue.`,
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:stop_sign: Sync stopped. Synced ${syncedCount}/${totalToSync} message(s).\n:point_right: Run \`/ff\` again to sync remaining ${remaining} message(s).`,
            },
          }],
        })
      );
      return;  // Don't start watching after stop
    }

    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: currentStatusMsgTs,
        text: `:white_check_mark: Synced ${totalToSync} message(s) from terminal.`,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:white_check_mark: Synced ${totalToSync} message(s) from terminal.`,
          },
        }],
      })
    );

    // 9. Start watching (same as /watch) - show terminal command
    const updateRate = effectiveSession.updateRateSeconds ?? 2;
    const terminalCommand = `cd ${effectiveSession.workingDir} && claude --dangerously-skip-permissions --resume ${sessionId}`;
    const watchStatusMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Continue in Terminal: ${terminalCommand}`,
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
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `:eye: Watching for terminal activity... Updates every ${updateRate}s`,
          }],
        },
        buildStopWatchingButton(sessionId),
      ],
    });

    const result = startWatching(channelId, threadTs, effectiveSession as Session, client, watchStatusMsg.ts as string, userId);
    if (!result.success) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:warning: Could not start watching: ${result.error}`,
      });
    }

  } catch (error) {
    console.error('[FastForward] Error:', error);
    await withSlackRetry(() =>
      client.chat.update({
        channel: channelId,
        ts: statusMsgTs,
        text: `:x: Failed to sync terminal messages: ${error instanceof Error ? error.message : String(error)}`,
      })
    );
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
  const forkPointLink = sourceThreadTs
    ? `https://slack.com/archives/${channelId}/p${forkPointMessageTs.replace('.', '')}?thread_ts=${sourceThreadTs}&cid=${channelId}`
    : `https://slack.com/archives/${channelId}/p${forkPointMessageTs.replace('.', '')}`;

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
    const newThreadLink = `https://slack.com/archives/${channelId}/p${newThreadTs.replace('.', '')}`;
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

    await uploadMarkdownAndPngWithResponse(
      client,
      channelId,
      strippedResponse,
      slackResponse,
      threadTs,
      undefined,  // userId
      500,        // threadCharLimit
      false,      // stripEmptyTag
      { threadTs, conversationKey }  // forkInfo for point-in-time forking
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

    console.log(`Received mention from ${event.user}: ${event.text}`);

    // Remove the @mention from the text
    const userText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    await handleMessage({
      channelId: event.channel,
      userId: event.user,
      userText,
      originalTs: event.ts,
      threadTs: event.thread_ts, // Only set if already in a thread
      client,
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

    console.log(`Received DM from ${userId}: ${userText}`);

    await handleMessage({
      channelId,
      userId,
      userText,
      originalTs: messageTs,
      client,
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
 * 1. Delete main session + all thread sessions from sessions.json
 * 2. Delete all corresponding SDK .jsonl files
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

    // Clear segment activity logs for the entire channel
    clearSegmentActivityLogs(event.channel);

    // Clean up segment-to-conversation lookup map for this channel
    const channelPrefix = `${event.channel}_`;
    for (const [segKey, convKey] of segmentToConversationKey.entries()) {
      if (convKey.startsWith(channelPrefix) || convKey === event.channel) {
        segmentToConversationKey.delete(segKey);
      }
    }

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
          blocks: buildStatusPanelBlocks({
            status: 'complete',
            mode: session.mode,
            model: processingState.model,
            toolsCompleted: processingState.toolsCompleted,
            elapsedMs: Date.now() - processingState.startTime,
            conversationKey,
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
        liveConfig.stripEmptyTag,
        { threadTs, conversationKey }  // forkInfo for point-in-time forking
      );
    } catch (e) {
      console.error('[PlanApproval] Failed to read/display plan file:', e);
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

  // Remove eyes reaction
  if (originalTs) {
    try {
      await client.reactions.remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch (e) {
      // Ignore - reaction may already be removed
    }
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
}) {
  const { channelId, userId, userText, originalTs, threadTs, client, skipConcurrentCheck } = params;
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
        thread_ts: threadTs,
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
      const forkPointLink = `https://slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
      const forkMessage = `🔀 _Forked with conversation state through: <${forkPointLink}|this message>_`;

      // Notify user about fork with link to actual fork point
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
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

  // Check for slash commands (e.g., /status, /mode, /continue)
  const commandResult = parseCommand(userText, session);

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
        thread_ts: threadTs,
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
    if (await checkBusyAndRespond(client, channelId, threadTs, conversationKey)) {
      return;
    }
    await runCompactSession(
      client,
      channelId,
      threadTs,
      session,
      originalTs
    );
    return;
  }

  // Handle /clear command (clear session history)
  if (commandResult.clearSession) {
    if (await checkBusyAndRespond(client, channelId, threadTs, conversationKey)) {
      return;
    }
    await runClearSession(
      client,
      channelId,
      threadTs,
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

    // Post header showing mode (so user always sees current mode)
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildHeaderBlocks({
          status: 'starting',
          mode: displayMode,
        }),
        text: displayMode,
      })
    );

    // Post command response
    if (commandResult.blocks) {
      const response = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: commandResult.blocks,
        text: 'Command response',
      });

      // Start terminal watcher if requested (for /continue command)
      if (commandResult.startTerminalWatch && session?.sessionId && response.ts) {
        const result = startWatching(channelId, threadTs, session, client, response.ts, userId);
        if (!result.success) {
          // Notify user of error
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `:warning: Could not start watching: ${result.error}`,
          });
        }
      }

    } else if (commandResult.stopTerminalWatch) {
      // Stop terminal watcher (for /stop-watching command)
      const stopped = stopWatching(channelId, threadTs);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: stopped
          ? ':white_check_mark: Stopped watching terminal session.'
          : ':information_source: No active terminal watcher in this conversation.',
      });
    } else if (commandResult.fastForward && session?.sessionId) {
      // Fast-forward: sync missed terminal messages and start watching
      await handleFastForwardSync(client, channelId, threadTs, session, userId);
    } else if (commandResult.response) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
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
      thread_ts: threadTs,
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
        thread_ts: threadTs,
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
        thread_ts: threadTs,
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
  if (await checkBusyAndRespond(client, channelId, threadTs, conversationKey)) {
    return;
  }

  // Mark conversation as busy
  busyConversations.add(conversationKey);

  // Initialize processing state for real-time activity tracking
  const startTime = Date.now();
  // messageTs for segment keys: use threadTs if in thread, originalTs if main channel
  const segmentMessageTs = threadTs || originalTs || `${channelId}_${startTime}`;
  const processingState: ProcessingState = {
    status: 'starting',
    toolsCompleted: 0,
    thinkingBlockCount: 0,
    startTime,
    lastUpdateTime: 0,
    updateRateSeconds: session.updateRateSeconds ?? UPDATE_RATE_DEFAULT,
    activityLog: [
      // Add starting entry so it persists in the log (not a fallback that disappears)
      { timestamp: startTime, type: 'starting' },
    ],
    currentThinkingIndex: null,
    currentThinkingContent: '',
    currentToolUseIndex: null,
    spinnerIndex: 0,
    rateLimitHits: 0,
    rateLimitNotified: false,
    autoCompactNotified: false,
    exitPlanModeIndex: null,
    exitPlanModeInputJson: '',
    exitPlanModeInput: null,
    fileToolInputs: new Map(),
    // Initialize from session (falls back to null if not set)
    planFilePath: session.planFilePath || null,
    // Segment tracking for View Log isolation
    currentSegmentKey: null,
    lastPostedActivityIndex: 0,
  };

  // Helper function to generate a new segment key and register it for lookup
  const startNewSegment = () => {
    const newKey = generateSegmentKey(channelId, segmentMessageTs);
    processingState.currentSegmentKey = newKey;
    segmentToConversationKey.set(newKey, conversationKey);
    // Save initial segment activity (even if empty, so View Log works immediately)
    const segmentActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);
    saveSegmentActivityLog(newKey, segmentActivity);
    return newKey;
  };

  // Post single combined message (activity log + status panel)
  // Activity log at top, status panel with abort button at bottom
  let statusMsgTs: string | undefined;
  // Start segment before initial post so View Log works immediately
  startNewSegment();
  try {
    const combinedResult = await withSlackRetry(async () =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildCombinedStatusBlocks({
          activityLog: processingState.activityLog,
          inProgress: true,
          status: 'starting',
          mode: session.mode,
          toolsCompleted: 0,
          elapsedMs: 0,
          conversationKey,
          spinner: SPINNER_FRAMES[0],  // Show spinner immediately
          segmentKey: processingState.currentSegmentKey || undefined,
        }),
        text: 'Claude is starting...',
      })
    );
    statusMsgTs = (combinedResult as { ts?: string }).ts;
  } catch (error) {
    console.error('Error posting combined status message:', error);
  }

  // Spinner timer - declared outside try block so it can be cleaned up in finally
  let spinnerTimer: NodeJS.Timeout | undefined;

  // Helper to move status message to bottom (delete old, post new)
  // Called after posting segments to keep Abort button at the bottom
  const moveStatusToBottom = async (): Promise<void> => {
    if (!statusMsgTs) return;

    // Delete old status message
    try {
      await client.chat.delete({
        channel: channelId,
        ts: statusMsgTs,
      });
    } catch (error) {
      console.log(`Could not delete old status message: ${error}`);
    }

    // Post new status message at bottom
    try {
      const trailingActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);
      const elapsedMs = Date.now() - processingState.startTime;
      const spinner = SPINNER_FRAMES[processingState.spinnerIndex];

      const result = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildCombinedStatusBlocks({
            activityLog: trailingActivity,
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
            segmentKey: processingState.currentSegmentKey || undefined,
          }),
          text: 'Claude is working...',
        })
      );
      const newTs = (result as { ts?: string }).ts;
      if (newTs) {
        statusMsgTs = newTs;
        // Update activeQueries with new ts
        const activeQuery = activeQueries.get(conversationKey);
        if (activeQuery) {
          activeQuery.statusMsgTs = newTs;
        }
      }
    } catch (error) {
      console.error('Failed to move status message to bottom:', error);
    }
  };

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
          threadTs,
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
          threadTs,
          undefined,  // userId
          liveConfig.threadCharLimit,
          liveConfig.stripEmptyTag,
          { threadTs, conversationKey }  // forkInfo for point-in-time forking
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
          thread_ts: threadTs,
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
          threadTs,
        });

        // Start reminder interval (4 hours) with 7-day expiry
        startToolApprovalReminder(approvalId, toolName, channelId, client, threadTs);
      });
    };

    // Start Claude query (returns Query object with interrupt() method)
    // For new thread forks, use forkSession flag with parent session ID
    // Also detect uninitialized forks created by /fork-thread (sessionId null but forkedFrom set)
    const needsFork = isNewFork || (session.sessionId === null && forkedFromSessionId !== null);
    // Determine thinking tokens: 0 = disabled, undefined = use default (31,999)
    const maxThinkingTokens = session.maxThinkingTokens === 0
      ? 0  // Disabled
      : (session.maxThinkingTokens ?? 31999);  // Use configured or default
    const claudeQuery = startClaudeQuery(userText!, {
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
        threadTs,
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
    // Note: lastPostedActivityIndex is now in processingState for segment isolation

    // Helper to start an in-progress thinking entry (for live streaming)
    const startThinkingEntry = () => {
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
      console.log(`[Activity] Thinking block started (in-progress), total: ${processingState.activityLog.length} entries`);
    };

    // Helper to update the in-progress thinking entry with rolling window (last 500 chars)
    const updateThinkingEntry = (content: string) => {
      // Find the last in-progress thinking entry
      for (let i = processingState.activityLog.length - 1; i >= 0; i--) {
        const entry = processingState.activityLog[i];
        if (entry.type === 'thinking' && entry.thinkingInProgress) {
          const elapsedMs = Date.now() - processingState.startTime;
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
    };

    // Helper to finalize the in-progress thinking entry
    const finalizeThinkingEntry = (content: string) => {
      // Find the last in-progress thinking entry and finalize it
      for (let i = processingState.activityLog.length - 1; i >= 0; i--) {
        const entry = processingState.activityLog[i];
        if (entry.type === 'thinking' && entry.thinkingInProgress) {
          const elapsedMs = Date.now() - processingState.startTime;
          // For final state, store full content and last 500 chars for summary (shows conclusion)
          const truncated = content.length > THINKING_TRUNCATE_LENGTH
            ? '...' + content.substring(content.length - THINKING_TRUNCATE_LENGTH)
            : content;
          entry.thinkingContent = content;
          entry.thinkingTruncated = truncated;
          entry.thinkingInProgress = false;
          entry.durationMs = elapsedMs;
          console.log(`[Activity] Thinking block finalized (${content.length} chars)`);
          break;
        }
      }
    };

    // Track generating chunks for activity log
    let generatingChunkCount = 0;
    let generatingStartTime: number | null = null;

    // Helper to finalize generating entry and post segment (called when tool starts or streaming completes)
    // Posts: 1) frozen activity segment, 2) response text for that segment
    const finalizeGeneratingEntry = async (segmentCharCount: number) => {
      const entry = processingState.activityLog.find(
        e => e.type === 'generating' && e.generatingInProgress
      );
      if (entry) {
        entry.generatingInProgress = false;
        entry.generatingChunks = generatingChunkCount;
        entry.generatingChars = segmentCharCount;
        entry.durationMs = Date.now() - (generatingStartTime || processingState.startTime);
        // Store response content for View Log modal (similar to thinking content)
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
      if (currentResponse.trim() && !isAborted(conversationKey)) {
        // 1. Get activity entries for THIS segment (from lastPostedActivityIndex to current end)
        const segmentActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);

        // 2. Post frozen activity segment (not in-progress)
        if (segmentActivity.length > 0) {
          try {
            // Ensure we have a segment key for this segment
            if (!processingState.currentSegmentKey) {
              startNewSegment();
            }
            const segmentKey = processingState.currentSegmentKey!;

            // Final save of segment activity before posting
            saveSegmentActivityLog(segmentKey, segmentActivity);

            const blocks = buildLiveActivityBlocks(segmentActivity, segmentKey, false);
            await withSlackRetry(
              () => client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                blocks,
                text: 'Activity',
              }),
              { onRateLimit: handleRateLimit }
            );
            console.log(`[Interleaved] Posted activity segment: ${segmentActivity.length} entries, key: ${segmentKey}`);

            // Clean up lookup map (segment is now persisted)
            segmentToConversationKey.delete(segmentKey);
            processingState.currentSegmentKey = null;
          } catch (error) {
            console.error('[Interleaved] Error posting activity segment:', error);
          }
        }

        // Mark activity as posted
        processingState.lastPostedActivityIndex = processingState.activityLog.length;

        // Start new segment immediately so View Log works for next activity
        // Don't wait for response text - activity may accumulate before next response
        startNewSegment();

        // 3. Post response text for this segment
        try {
          const liveConfig = getLiveSessionConfig(channelId, threadTs);
          const strippedResponse = stripMarkdownCodeFence(currentResponse, {
            stripEmptyTag: liveConfig.stripEmptyTag,
          });
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
            threadTs,
            userId,
            liveConfig.threadCharLimit,
            liveConfig.stripEmptyTag,
            { threadTs, conversationKey },  // forkInfo for point-in-time forking
            mappingInfo  // NEW: immediate mapping save
          );

          // Track successfully mapped UUIDs so we don't create placeholders for them
          if (uploadResult?.ts && mappingInfo) {
            mappedAssistantUuids.add(mappingInfo.sdkMessageId);
          }

          console.log(`[Interleaved] Posted response segment: ${currentResponse.length} chars${mappingInfo ? ` (mapped: ${mappingInfo.sdkMessageId})` : ''}`);
        } catch (error) {
          console.error('[Interleaved] Error posting response segment:', error);
        }

        // 4. Reset currentResponse for next segment (keep fullResponse for total tracking)
        currentResponse = '';

        // 5. Move status message to bottom so it's always below segments
        // MUST use mutex to prevent race with periodic update timer
        const mutex = getUpdateMutex(conversationKey);
        await mutex.runExclusive(async () => {
          if (isAborted(conversationKey)) return;
          await moveStatusToBottom();
        });
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

    // Helper to add tool start to activity log
    const logToolStart = async (toolName: string) => {
      // Finalize any in-progress generating entry before tool starts
      // This posts the current segment (activity + text) before the tool
      await finalizeGeneratingEntry(currentResponse.length);

      const formattedName = formatToolName(toolName);
      const elapsedMs = Date.now() - processingState.startTime;
      processingState.activityLog.push({
        timestamp: Date.now(),
        type: 'tool_start',
        tool: formattedName,
        durationMs: elapsedMs,  // Time since processing started
      });
      processingState.currentTool = formattedName;
      processingState.status = 'tool';
      console.log(`[Activity] Tool start: ${formattedName}, total: ${processingState.activityLog.length} entries`);
    };

    // Helper to add tool complete to activity log
    const logToolComplete = async () => {
      // Finalize any in-progress generating entry before tool completes
      // This handles generating entries created DURING tool execution
      await finalizeGeneratingEntry(currentResponse.length);

      const lastToolStart = [...processingState.activityLog].reverse().find(e => e.type === 'tool_start');
      if (lastToolStart) {
        // Calculate duration from tool start to now
        const durationMs = Date.now() - lastToolStart.timestamp;
        processingState.activityLog.push({
          timestamp: Date.now(),
          type: 'tool_complete',
          tool: lastToolStart.tool,
          durationMs,
        });
        console.log(`[Activity] Tool complete: ${lastToolStart.tool} (${durationMs}ms), total: ${processingState.activityLog.length} entries`);
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
            thread_ts: threadTs,
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

        // Update combined message with CURRENT segment activity only
        // Completed segments have been posted as separate messages
        if (statusMsgTs) {
          try {
            // Only show trailing activity (from lastPostedActivityIndex onwards)
            const trailingActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);

            // Save segment activity log so View Log shows current state during processing
            const segmentKey = processingState.currentSegmentKey;
            if (segmentKey) {
              saveSegmentActivityLog(segmentKey, trailingActivity);
            }

            await withSlackRetry(
              () =>
                client.chat.update({
                  channel: channelId,
                  ts: statusMsgTs,
                  blocks: buildCombinedStatusBlocks({
                    activityLog: trailingActivity,
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
                    segmentKey: processingState.currentSegmentKey || undefined,
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
    const scheduleUpdate = () => {
      const intervalMs = processingState.updateRateSeconds * 1000;
      spinnerTimer = setTimeout(() => {
        updateStatusMessages();
        scheduleUpdate();  // Reschedule with potentially new rate
      }, intervalMs);
    };
    scheduleUpdate();

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
      }

      // Capture session ID and model from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        newSessionId = (msg as any).session_id;
        modelName = (msg as any).model;
        processingState.model = modelName;
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

      // Detect auto-compaction during regular queries
      if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
        const metadata = (msg as any).compact_metadata;
        const trigger = metadata?.trigger;

        // Only notify for auto-triggered compaction (manual has its own flow)
        if (trigger === 'auto' && !processingState.autoCompactNotified) {
          processingState.autoCompactNotified = true;
          const preTokens = metadata?.pre_tokens;
          const tokenInfo = preTokens ? ` (was ${preTokens.toLocaleString()} tokens)` : '';

          await withSlackRetry(
            async () =>
              client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `:gear: Auto-compacting context${tokenInfo}...`,
              }),
            { onRateLimit: handleRateLimit }
          );

          console.log(`[AutoCompact] Triggered - pre_tokens: ${preTokens}`);
        }
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
          startThinkingEntry();
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

        // Thinking block completed - finalize entry with full content
        if (event?.type === 'content_block_stop' &&
            processingState.currentThinkingIndex === event.index &&
            processingState.currentThinkingContent) {
          finalizeThinkingEntry(processingState.currentThinkingContent);
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

          // Track ALL tool_use blocks for plan file path capture
          // Write/Edit/Read use file_path param, Grep/Glob use path param
          if (event.content_block?.type === 'tool_use') {
            processingState.fileToolInputs.set(event.index, '');
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

        // Accumulate JSON input for file tools (Write/Edit/Read for plan file capture)
        if (event?.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            processingState.fileToolInputs.has(event.index)) {
          const current = processingState.fileToolInputs.get(event.index) || '';
          processingState.fileToolInputs.set(event.index, current + (event.delta.partial_json || ''));
        }

        // Tool use completed (content_block_stop for tool_use block)
        if (event?.type === 'content_block_stop' &&
            processingState.currentToolUseIndex === event.index &&
            processingState.currentTool) {
          await logToolComplete();

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

          // Parse file tool input to capture plan file path
          // Write/Edit/Read use file_path, Grep/Glob use path
          if (processingState.fileToolInputs.has(event.index)) {
            try {
              const inputJson = processingState.fileToolInputs.get(event.index) || '{}';
              const input = JSON.parse(inputJson);
              // Check both file_path (Write/Edit/Read) and path (Grep/Glob)
              const planPath = input.file_path || input.path;
              if (typeof planPath === 'string' && planPath.includes('.claude/plans/')) {
                processingState.planFilePath = planPath;
                // Persist to session for cross-turn access
                if (threadTs) {
                  await saveThreadSession(channelId, threadTs, { planFilePath: planPath });
                } else {
                  await saveSession(channelId, { planFilePath: planPath });
                }
                console.log('[PlanFile] Detected and persisted plan file:', planPath);
              }
            } catch (e) {
              console.error('[PlanFile] JSON parse failed:', e);
            }
            processingState.fileToolInputs.delete(event.index);
          }

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

      // Handle result messages (final response with stats)
      if (msg.type === 'result') {
        const resultMsg = msg as any;
        isActivelyStreaming = false;  // No longer in middle of streaming

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
        }
      }
    }

    // Finalize the final segment (posts remaining activity + currentResponse if any)
    // This handles the case where the query ends with a response (not a tool)
    if (generatingChunkCount > 0 || currentResponse.trim()) {
      await finalizeGeneratingEntry(currentResponse.length);
    }

    // Stop the spinner timer now that processing is complete
    clearTimeout(spinnerTimer);

    // Calculate context percentage using input tokens + cache read tokens
    // This gives accurate context utilization since cached tokens are in the context window
    const totalContextTokens = (processingState.inputTokens || 0) + (processingState.cacheReadInputTokens || 0);
    const contextPercent = processingState.contextWindow && totalContextTokens > 0
      ? Number(((totalContextTokens / processingState.contextWindow) * 100).toFixed(1))
      : undefined;

    // Calculate % left until auto-compact triggers
    // Auto-compact threshold is approximately 77.5% of context window (based on CLI behavior)
    const AUTOCOMPACT_THRESHOLD_PERCENT = 0.775;
    const compactPercent = processingState.contextWindow && totalContextTokens > 0
      ? Number((((processingState.contextWindow * AUTOCOMPACT_THRESHOLD_PERCENT - totalContextTokens) / processingState.contextWindow) * 100).toFixed(1))
      : undefined;

    // Final elapsed time
    const finalDurationMs = processingState.durationMs ?? (Date.now() - processingState.startTime);

    // Update combined message to completion state (only if not aborted)
    if (!isAborted(conversationKey)) {
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        // Post any trailing activity that wasn't part of a segment (activity after last response)
        const trailingActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);
        if (trailingActivity.length > 0) {
          try {
            // Generate segment key for trailing activity
            if (!processingState.currentSegmentKey) {
              startNewSegment();
            }
            const segmentKey = processingState.currentSegmentKey!;

            // Save segment activity before posting
            saveSegmentActivityLog(segmentKey, trailingActivity);

            const blocks = buildLiveActivityBlocks(trailingActivity, segmentKey, false);
            await withSlackRetry(
              () => client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                blocks,
                text: 'Activity',
              }),
              { onRateLimit: handleRateLimit }
            );
            console.log(`[Interleaved] Posted trailing activity: ${trailingActivity.length} entries, key: ${segmentKey}`);

            // Clean up lookup map
            segmentToConversationKey.delete(segmentKey);
            processingState.currentSegmentKey = null;
          } catch (error) {
            console.error('[Interleaved] Error posting trailing activity:', error);
          }
        }

        // Update initial status message to completion state (with Beginning header + activity + Complete + stats)
        if (statusMsgTs) {
          try {
            // Build completion blocks: full combined view with Beginning header preserved
            const trailingActivity = processingState.activityLog.slice(processingState.lastPostedActivityIndex);
            const completionBlocks = buildCombinedStatusBlocks({
              activityLog: trailingActivity,
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
              costUsd: processingState.costUsd,
              conversationKey: activityLogKey,
              rateLimitHits: processingState.rateLimitHits,
              segmentKey: processingState.currentSegmentKey || undefined,
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

      // Save activity log for modal/download (keyed by message, not conversation)
      console.log(`[Activity] Saving activity log for ${activityLogKey}: ${processingState.activityLog.length} entries`);
      await saveActivityLog(activityLogKey, processingState.activityLog);

      // Save usage data for /status and /context commands
      if (processingState.model && processingState.contextWindow) {
        const lastUsage: LastUsage = {
          inputTokens: processingState.inputTokens || 0,
          outputTokens: processingState.outputTokens || 0,
          cacheReadInputTokens: processingState.cacheReadInputTokens || 0,
          contextWindow: processingState.contextWindow,
          model: processingState.model,
        };
        if (threadTs) {
          await saveThreadSession(channelId, threadTs, { lastUsage });
          console.log(`[Usage] Saved thread lastUsage: ${lastUsage.inputTokens + lastUsage.cacheReadInputTokens}/${lastUsage.contextWindow} tokens (${Math.round((lastUsage.inputTokens + lastUsage.cacheReadInputTokens) / lastUsage.contextWindow * 100)}%)`);
        } else {
          await saveSession(channelId, { lastUsage });
          console.log(`[Usage] Saved lastUsage: ${lastUsage.inputTokens + lastUsage.cacheReadInputTokens}/${lastUsage.contextWindow} tokens (${Math.round((lastUsage.inputTokens + lastUsage.cacheReadInputTokens) / lastUsage.contextWindow * 100)}%)`);
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
        threadTs,
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

      await showPlanApprovalUI({
        client,
        channelId,
        threadTs,
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

        // Add error to activity log
        processingState.activityLog.push({
          timestamp: Date.now(),
          type: 'error',
          message: error.message,
        });

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
                segmentKey: processingState.currentSegmentKey || undefined,
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

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Error: ${error.message}`,
    });
  } finally {
    // Clear spinner timer to prevent memory leak (important if error occurs before normal cleanup)
    if (spinnerTimer) {
      clearTimeout(spinnerTimer);
    }
    // Always clean up busy state, active queries, and mutex
    busyConversations.delete(conversationKey);
    activeQueries.delete(conversationKey);
    clearAborted(conversationKey);
    cleanupMutex(conversationKey);
  }
}

// Handle button clicks for ask_user tool
app.action(/^answer_(.+)_(\d+)$/, async ({ action, ack, body, client }) => {
  await ack();

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

// Handle "Abort" button for ask_user questions
app.action(/^abort_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^abort_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`Abort clicked for question: ${questionId}`);

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
  const bodyWithChannel = body as any;
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `*Aborted* - Question cancelled by user`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating message:', error);
    }
  }
});

// Handle multi-select selection changes (stores selection, doesn't submit yet)
app.action(/^multiselect_(?!submit_)(.+)$/, async ({ action, ack }) => {
  await ack();

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
  await ack();

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

// Handle abort query button (abort during processing)
app.action(/^abort_query_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^abort_query_(.+)$/);
  const conversationKey = match ? match[1] : '';

  console.log(`Abort query clicked for conversation: ${conversationKey}`);

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

    const bodyWithChannel = body as any;
    const channelId = bodyWithChannel.channel?.id;

    if (channelId) {
      // Use mutex to ensure abort update comes after any in-flight status update
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        const elapsedMs = Date.now() - active.processingState.startTime;

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
              segmentKey: active.processingState.currentSegmentKey || undefined,
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
  } else {
    console.log(`No active query found for: ${conversationKey}`);
  }
});

// Handle "Type something" button - opens modal for free text input
app.action(/^freetext_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

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

  console.log(`Plan option 1 (clear + bypass) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Clearing context and proceeding with bypass mode...');

  // Get plan file path before clearing (from activeQuery's processingState)
  const activeQuery = activeQueries.get(conversationKey);
  const planFilePath = activeQuery?.processingState?.planFilePath;

  // Clear session (set sessionId to null) and set bypass mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { sessionId: null, mode: 'bypassPermissions' });
  } else {
    await saveSession(channelId, { sessionId: null, mode: 'bypassPermissions' });
  }

  const bodyWithChannel = body as any;
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: planFilePath
      ? `Execute the plan at ${planFilePath}`
      : 'Yes, proceed with the plan.',
    originalTs: threadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Option 2: Accept edits (auto-accept code edits only)
app.action(/^plan_accept_edits_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_accept_edits_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan option 2 (accept edits) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with accept-edits mode...');

  // Set acceptEdits mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'acceptEdits' });
  } else {
    await saveSession(channelId, { mode: 'acceptEdits' });
  }

  const bodyWithChannel = body as any;
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: threadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Option 3: Bypass permissions (auto-accept all)
app.action(/^plan_bypass_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_bypass_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan option 3 (bypass) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with bypass mode...');

  // Set bypassPermissions mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'bypassPermissions' });
  } else {
    await saveSession(channelId, { mode: 'bypassPermissions' });
  }

  const bodyWithChannel = body as any;
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: threadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Option 4: Manual approve (ask for each tool)
app.action(/^plan_manual_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_manual_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan option 4 (manual) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '✅ Proceeding with manual approval mode...');

  // Set default (ask) mode (thread-aware)
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { mode: 'default' });
  } else {
    await saveSession(channelId, { mode: 'default' });
  }

  const bodyWithChannel = body as any;
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: threadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Option 5: Reject/Change the plan
app.action(/^plan_reject_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const conversationKey = extractPlanApprovalConversationKey(action, /^plan_reject_(.+)$/);
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan option 5 (reject/change) clicked for: ${conversationKey}`);

  await updateApprovalMessage(body, client, '❌ Plan rejected. Tell Claude what to change.');

  // Keep mode as plan, send rejection message to Claude
  const bodyWithChannel = body as any;
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'No, I want to change the plan. Please wait for my feedback.',
    originalTs: threadTs,
    threadTs,
    client,
    skipConcurrentCheck: true,
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
app.action(/^sdkq_([^_]+)_(\d+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_([^_]+)_(\d+)$/);
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
  await ack();

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
  await ack();

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

// Handle SDK AskUserQuestion abort button
app.action(/^sdkq_abort_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^sdkq_abort_(.+)$/);
  const questionId = match ? match[1] : '';

  console.log(`SDK question abort clicked for: ${questionId}`);

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
});

// Handle SDK AskUserQuestion "Other" button (free-text input)
app.action(/^sdkq_other_(.+)$/, async ({ ack, body, client }) => {
  await ack();

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
  await ack();

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
// Activity Log Modal and Download Handlers (Segment-Based)
// ============================================================================

const MODAL_PAGE_SIZE = 15;  // Entries per page for modal

// Handle "View Log" button click - opens modal with SEGMENT-SPECIFIC activity log
// Each View Log button now uses a unique segment key to show only that segment's entries
app.action(/^view_segment_log_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^view_segment_log_(.+)$/);
  const segmentKey = match ? match[1] : '';

  console.log(`[ViewLog] Segment view requested: ${segmentKey}`);

  const bodyWithTrigger = body as any;
  const triggerId = bodyWithTrigger.trigger_id;

  if (!triggerId) {
    console.error('No trigger_id found for segment log modal');
    return;
  }

  // Get segment-specific activity log from in-memory storage
  // This works for BOTH in-progress (updated via updateSegmentActivityLog) AND completed segments
  let activityLog = getSegmentActivityLog(segmentKey);

  // If not found in segment storage, check if this is an active query segment
  // (fallback for edge case where View Log clicked before first save)
  if (!activityLog) {
    const conversationKey = segmentToConversationKey.get(segmentKey);
    if (conversationKey) {
      const activeQuery = activeQueries.get(conversationKey);
      if (activeQuery && activeQuery.processingState.currentSegmentKey === segmentKey) {
        // Get current segment activity from processingState
        const lastIdx = activeQuery.processingState.lastPostedActivityIndex || 0;
        activityLog = activeQuery.processingState.activityLog.slice(lastIdx);
        console.log(`[ViewLog] Retrieved from active query: ${activityLog.length} entries`);
      }
    }
  }

  if (!activityLog || activityLog.length === 0) {
    // Segment not found or empty - session was cleared or bot restarted
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Activity Log' },
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: Activity log is no longer available.\n\nThis can happen if the session was cleared or the bot was restarted.',
            },
          }],
        },
      });
    } catch (error) {
      console.error('Error opening segment log error modal:', error);
    }
    return;
  }

  console.log(`[ViewLog] Showing ${activityLog.length} entries for segment`);

  // Open modal with first page - uses segment key for pagination state
  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: buildActivityLogModalView(activityLog, 1, totalPages, segmentKey),
    });
  } catch (error) {
    console.error('Error opening segment log modal:', error);
  }
});

// Handle pagination buttons in modal (uses segmentKey from private_metadata)
app.action(/^activity_log_page_(\d+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^activity_log_page_(\d+)$/);
  const page = match ? parseInt(match[1], 10) : 1;

  const bodyWithView = body as any;
  const viewId = bodyWithView.view?.id;
  const privateMetadata = bodyWithView.view?.private_metadata;

  if (!viewId || !privateMetadata) {
    console.error('Missing view info for pagination');
    return;
  }

  let metadata: { segmentKey: string };
  try {
    metadata = JSON.parse(privateMetadata);
  } catch (e) {
    console.error('Error parsing private_metadata:', e);
    return;
  }

  const { segmentKey } = metadata;

  // Get segment-specific activity log
  let activityLog = getSegmentActivityLog(segmentKey);

  // Fallback to active query if segment not found (in-progress)
  if (!activityLog) {
    const conversationKey = segmentToConversationKey.get(segmentKey);
    if (conversationKey) {
      const activeQuery = activeQueries.get(conversationKey);
      if (activeQuery && activeQuery.processingState.currentSegmentKey === segmentKey) {
        const lastIdx = activeQuery.processingState.lastPostedActivityIndex || 0;
        activityLog = activeQuery.processingState.activityLog.slice(lastIdx);
      }
    }
  }

  if (!activityLog) {
    console.error('Segment activity log not found for pagination');
    return;
  }

  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);

  // Update modal with new page (in-place pagination)
  try {
    await client.views.update({
      view_id: viewId,
      view: buildActivityLogModalView(activityLog, page, totalPages, segmentKey),
    });
  } catch (error) {
    console.error('Error updating segment log modal page:', error);
  }
});

// Handle "Download .txt" button click - uploads SEGMENT-SPECIFIC activity log as file
app.action(/^download_segment_log_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^download_segment_log_(.+)$/);
  const segmentKey = match ? match[1] : '';

  console.log(`[Download] Segment download requested: ${segmentKey}`);

  const bodyWithChannel = body as any;
  const channelId = bodyWithChannel.channel?.id;
  const threadTs = bodyWithChannel.message?.thread_ts;

  if (!channelId) {
    console.error('No channel_id found for segment log download');
    return;
  }

  // Get segment-specific activity log
  let activityLog = getSegmentActivityLog(segmentKey);

  // Fallback to active query if segment not found (in-progress)
  if (!activityLog) {
    const conversationKey = segmentToConversationKey.get(segmentKey);
    if (conversationKey) {
      const activeQuery = activeQueries.get(conversationKey);
      if (activeQuery && activeQuery.processingState.currentSegmentKey === segmentKey) {
        const lastIdx = activeQuery.processingState.lastPostedActivityIndex || 0;
        activityLog = activeQuery.processingState.activityLog.slice(lastIdx);
      }
    }
  }

  if (!activityLog || activityLog.length === 0) {
    // Segment not found or empty
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithChannel.user?.id || 'unknown',
        text: ':warning: Activity log is no longer available.\n\nThis can happen if the session was cleared or the bot was restarted.',
      });
    } catch (error) {
      console.error('Error posting segment log unavailable message:', error);
    }
    return;
  }

  // Format as plain text with FULL thinking content
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`Activity Log Segment`);
  lines.push(`Segment Key: ${segmentKey}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('='.repeat(60));
  lines.push('');

  for (const entry of activityLog) {
    const timestamp = new Date(entry.timestamp).toISOString();
    const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';

    if (entry.type === 'starting') {
      lines.push(`[${timestamp}] STARTED`);
    } else if (entry.type === 'thinking') {
      // Include FULL thinking content in download
      lines.push(`[${timestamp}] THINKING:`);
      lines.push('-'.repeat(40));
      lines.push(entry.thinkingContent || entry.thinkingTruncated || '');
      lines.push('-'.repeat(40));
      lines.push('');
    } else if (entry.type === 'tool_start') {
      lines.push(`[${timestamp}] TOOL START: ${entry.tool || 'unknown'}`);
    } else if (entry.type === 'tool_complete') {
      lines.push(`[${timestamp}] TOOL COMPLETE: ${entry.tool || 'unknown'}${duration}`);
    } else if (entry.type === 'generating') {
      const chars = entry.generatingChars ? ` (${entry.generatingChars} chars)` : '';
      lines.push(`[${timestamp}] RESPONSE${duration}${chars}:`);
      if (entry.generatingContent) {
        lines.push('-'.repeat(40));
        lines.push(entry.generatingContent);
        lines.push('-'.repeat(40));
        lines.push('');
      }
    } else if (entry.type === 'error') {
      lines.push(`[${timestamp}] ERROR: ${entry.message || 'unknown'}`);
    }
  }

  const content = lines.join('\n');
  const filename = `activity-log-${segmentKey.replace(/[^a-zA-Z0-9_-]/g, '-')}.txt`;

  // Upload as file snippet (requires files:write scope)
  try {
    await client.files.uploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      content,
      filename,
      title: 'Activity Log',
    });
  } catch (error) {
    console.error('Error uploading segment log file:', error);
    // Post error message
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithChannel.user?.id || 'unknown',
        text: ':warning: Failed to upload activity log. The bot may need `files:write` permission.',
      });
    } catch (e) {
      console.error('Error posting upload error message:', e);
    }
  }
});

// Handle "Fork here" button click - creates point-in-time fork from a specific message
app.action(/^fork_here_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  // Extract conversationKey from action_id
  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^fork_here_(.+)$/);
  const conversationKey = match ? match[1] : '';

  // Get messageTs from the message the button is on (Slack provides this)
  const bodyWithMessage = body as any;
  const messageTs = bodyWithMessage.message?.ts;
  if (!messageTs) {
    console.error('[ForkHere] Could not get message timestamp from body');
    return;
  }

  // Parse { threadTs } from action.value (threadTs may be undefined for main channel)
  const valueStr = 'value' in action ? (action.value || '{}') : '{}';
  let forkInfo: { threadTs?: string };
  try {
    forkInfo = JSON.parse(valueStr);
  } catch {
    console.error('[ForkHere] Invalid forkInfo JSON:', valueStr);
    return;
  }

  const { threadTs } = forkInfo;  // May be undefined for main channel

  // Derive channelId from conversationKey (format: channelId or channelId_threadTs)
  const channelId = conversationKey.split('_')[0];
  const userId = body.user?.id || 'unknown';

  // Create the point-in-time fork
  const result = await createForkFromMessage({
    channelId,
    sourceThreadTs: threadTs,
    forkPointMessageTs: messageTs,
    client: client as any,
    userId,
  });

  if (!result.success) {
    // Post error message in thread
    try {
      await (client as any).chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ ${result.error}`,
      });
    } catch (error) {
      console.error('[ForkHere] Error posting error message:', error);
    }
  }
});

// Handle "Stop Watching" button click for terminal session watcher
app.action('stop_terminal_watch', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel?.id;
  if (!channelId) return;

  // Get threadTs from message if in thread
  const bodyWithMessage = body as any;
  const threadTs = bodyWithMessage.message?.thread_ts;

  const stopped = stopWatching(channelId, threadTs);

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
