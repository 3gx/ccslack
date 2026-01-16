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
  ThreadSession,
  PermissionMode,
  ActivityEntry,
} from './session-manager.js';
import { isSessionActiveInTerminal, buildConcurrentWarningBlocks, getContinueCommand } from './concurrent-check.js';
import {
  buildStatusBlocks,
  buildHeaderBlocks,
  buildPlanApprovalBlocks,
  isPlanApprovalPrompt,
  buildToolApprovalBlocks,
  buildForkAnchorBlocks,
  buildPathSetupBlocks,
  buildStatusPanelBlocks,
  buildActivityLogText,
  buildCollapsedActivityBlocks,
  formatToolName,
  getToolEmoji,
  buildActivityLogModalView,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
} from './blocks.js';
import {
  getAvailableModels,
  isModelAvailable,
  refreshModelCache,
  getModelInfo,
} from './model-cache.js';
import { postSplitResponse } from './streaming.js';
import { markAborted, isAborted, clearAborted } from './abort-tracker.js';
import { markdownToSlack, formatTimeRemaining } from './utils.js';
import { parseCommand } from './commands.js';
import { toUserMessage, SlackBotError, Errors } from './errors.js';
import { withSlackRetry } from './retry.js';
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
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted';
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  thinkingBlockCount: number;
  startTime: number;
  lastUpdateTime: number;
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
  statusMsgTs: string;           // Message 1: Status panel
  activityLogMsgTs: string;      // Message 2: Activity log
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

// Track tool approval reminders (matches MCP ask_user pattern)
const toolApprovalReminderIntervals = new Map<string, NodeJS.Timeout>();
const toolApprovalReminderCounts = new Map<string, number>();
const toolApprovalReminderStartTimes = new Map<string, number>();

// Helper to get unique conversation key (channel + thread)
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
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

// Handle /fork-thread command - creates new thread from existing thread session
async function handleForkThread(params: {
  channelId: string;
  sourceThreadTs: string;
  forkCommandTs: string;  // The specific message where /fork-thread was typed
  description: string;
  client: any;
}): Promise<void> {
  const { channelId, sourceThreadTs, forkCommandTs, description, client } = params;

  // 1. Get source thread's session
  const sourceSession = getThreadSession(channelId, sourceThreadTs);
  if (!sourceSession?.sessionId) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: sourceThreadTs,
        text: '❌ Cannot fork: no active session in this thread.',
      })
    );
    return;
  }

  // 2. Create new top-level message in main DM (anchor for new thread)
  const anchorMessage = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      text: `🔀 Forked: ${description}`,
      blocks: buildForkAnchorBlocks({ description }),
    })
  );
  const newThreadTs = (anchorMessage as { ts?: string }).ts!;

  // 3. Create forked thread session (sessionId null until SDK creates it)
  saveThreadSession(channelId, newThreadTs, {
    sessionId: null,
    forkedFrom: sourceSession.sessionId,
    forkedFromThreadTs: sourceThreadTs,
    workingDir: sourceSession.workingDir,
    mode: sourceSession.mode,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });

  // 4. Post first message in new thread with link to the fork command message
  // Slack message links: https://slack.com/archives/{channel}/p{ts_without_dot}?thread_ts={thread_ts}
  const forkCommandLink = `https://slack.com/archives/${channelId}/p${forkCommandTs.replace('.', '')}?thread_ts=${sourceThreadTs}&cid=${channelId}`;
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: newThreadTs,
      text: `_Forked from <${forkCommandLink}|previous thread>. Ready to explore: ${description}_\n\nSend a message to continue.`,
    })
  );

  // 5. Notify in source thread with link to new thread
  const newThreadLink = `https://slack.com/archives/${channelId}/p${newThreadTs.replace('.', '')}`;
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: sourceThreadTs,
      text: `_Session forked to <${newThreadLink}|new thread>._`,
    })
  );
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
    deleteSession(event.channel);

    console.log(`${'='.repeat(60)}\n`);
  } catch (error) {
    console.error('Error handling channel deletion:', error);
    // Don't throw - cleanup failure shouldn't crash the bot
    // Log the error and continue running
  }
});

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

  // Check if conversation is busy
  if (busyConversations.has(conversationKey)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I'm busy with the current request. Please wait for it to complete, or click Abort.",
    });
    return;
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
  };
  let isNewFork = false;
  let forkedFromSessionId: string | null = null;

  // Track resumeSessionAt for point-in-time forking
  let resumeSessionAtMessageId: string | undefined;

  if (threadTs) {
    // Thread message - find fork point for point-in-time forking
    const forkPointMessageId = findForkPointMessageId(channelId, threadTs);
    if (forkPointMessageId) {
      console.log(`[Fork] Thread will fork from message ${forkPointMessageId}`);
      resumeSessionAtMessageId = forkPointMessageId;
    } else {
      console.warn(`[Fork] No message mapping found for ${threadTs} - will fork from latest state`);
    }

    // Thread message - use or create forked session
    const threadResult = getOrCreateThreadSession(channelId, threadTs, forkPointMessageId);
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
      };
      saveSession(channelId, mainSession);
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

  // Check for > fork: prefix in threads (thread-to-thread forking)
  const forkMatch = userText.match(/^>\s*fork:\s*(.+)/i);
  if (forkMatch && threadTs && originalTs) {
    await handleForkThread({
      channelId,
      sourceThreadTs: threadTs,
      forkCommandTs: originalTs,
      description: forkMatch[1].trim(),
      client,
    });
    // Remove eyes reaction - fork done
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
    return;
  }

  // Check for slash commands (e.g., /status, /mode, /continue)
  const commandResult = parseCommand(userText, session);

  // Handle /fork-thread command (requires thread context)
  if (commandResult.forkThread) {
    if (!threadTs || !originalTs) {
      // Error: /fork-thread used outside of thread
      await client.chat.postMessage({
        channel: channelId,
        text: '❌ `/fork-thread` can only be used inside a thread.',
      });
    } else {
      await handleForkThread({
        channelId,
        sourceThreadTs: threadTs,
        forkCommandTs: originalTs,
        description: commandResult.forkThread.description,
        client,
      });
    }
    // Remove eyes reaction - fork done
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
    return;
  }

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

  if (commandResult.handled) {
    // Apply any session updates from the command
    // Use updated mode if command changed it, otherwise use current mode
    const displayMode = commandResult.sessionUpdate?.mode || session.mode;
    if (commandResult.sessionUpdate) {
      // Add userId for /path command
      if (commandResult.sessionUpdate.pathConfigured) {
        commandResult.sessionUpdate.configuredBy = userId ?? null;
      }
      saveSession(channelId, commandResult.sessionUpdate);
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
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: commandResult.blocks,
        text: 'Command response',
      });
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

      // Clear invalid model from session
      saveSession(channelId, { model: undefined });

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

  // Capture user message timestamp for message mapping (main channel only)
  // This enables point-in-time thread forking by tracking which SDK messages
  // correspond to which Slack timestamps
  if (!threadTs && originalTs) {
    saveMessageMapping(channelId, originalTs, {
      sdkMessageId: `user_${originalTs}`,  // Placeholder - user messages don't have SDK IDs
      type: 'user',
    });
    console.log(`[Mapping] Saved user message mapping for ${originalTs}`);
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
  };

  // Post Message 1: Status panel (Block Kit with Abort)
  let statusMsgTs: string | undefined;
  try {
    const statusResult = await withSlackRetry(async () =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildStatusPanelBlocks({
          status: 'starting',
          mode: session.mode,
          toolsCompleted: 0,
          elapsedMs: 0,
          conversationKey,
          spinner: SPINNER_FRAMES[0],  // Show spinner immediately
        }),
        text: 'Claude is starting...',
      })
    );
    statusMsgTs = (statusResult as { ts?: string }).ts;
  } catch (error) {
    console.error('Error posting status panel message:', error);
  }

  // Post Message 2: Activity log (text)
  let activityLogMsgTs: string | undefined;
  try {
    const activityResult = await withSlackRetry(async () =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        // Use buildActivityLogText to render starting entry (not static placeholder)
        text: buildActivityLogText(processingState.activityLog, true),
      })
    );
    activityLogMsgTs = (activityResult as { ts?: string }).ts;
  } catch (error) {
    console.error('Error posting activity log message:', error);
  }

  // Stream Claude response to Slack with real-time updates
  try {
    // Create canUseTool callback for manual approval mode (default mode)
    // This callback is called by the SDK when it needs to approve a tool use
    // Uses 7-day timeout with 4-hour reminders (matches MCP ask_user behavior)
    const canUseTool = session.mode === 'default'
      ? async (toolName: string, toolInput: Record<string, unknown>, _options: { signal: AbortSignal }): Promise<PermissionResult> => {
          // Auto-deny MCP approve_action tool - we handle approvals directly via canUseTool
          // Without this, we'd get double approval: canUseTool for approve_action, then MCP's own UI
          if (toolName === 'mcp__ask-user__approve_action') {
            console.log(`Auto-denying ${toolName} - approvals handled via canUseTool`);
            return { behavior: 'deny', message: 'Tool approvals are handled directly via Slack buttons, not via MCP approve_action.' };
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
        }
      : undefined;

    // Start Claude query (returns Query object with interrupt() method)
    // For new thread forks, use forkSession flag with parent session ID
    // Also detect uninitialized forks created by /fork-thread (sessionId null but forkedFrom set)
    const needsFork = isNewFork || (session.sessionId === null && forkedFromSessionId !== null);
    const claudeQuery = startClaudeQuery(userText!, {
      sessionId: needsFork ? forkedFromSessionId ?? undefined : session.sessionId ?? undefined,
      workingDir: session.workingDir,
      mode: session.mode,
      model: session.model,  // Pass validated model (or undefined for SDK default)
      forkSession: needsFork,  // Fork when first message in thread or uninitialized fork
      resumeSessionAt: needsFork ? resumeSessionAtMessageId : undefined,  // Point-in-time forking
      canUseTool,  // For manual approval in default mode
      slackContext: {
        channel: channelId,
        threadTs,
        user: userId ?? 'unknown',
      },
    });

    // Track active query for abort capability (with both message timestamps)
    if (statusMsgTs && activityLogMsgTs) {
      activeQueries.set(conversationKey, {
        query: claudeQuery,
        statusMsgTs,
        activityLogMsgTs,
        mode: session.mode,
        processingState,
      });
    }

    // Collect complete response from SDK (no streaming placeholder needed)
    let fullResponse = '';
    let newSessionId: string | null = null;
    let modelName: string | undefined;
    let currentAssistantMessageId: string | null = null;  // For message mapping
    let costUsd: number | undefined;

    // Helper to add thinking to activity log
    const logThinking = (content: string) => {
      const truncated = content.length > THINKING_TRUNCATE_LENGTH
        ? content.substring(0, THINKING_TRUNCATE_LENGTH) + '...'
        : content;
      const elapsedMs = Date.now() - processingState.startTime;

      processingState.activityLog.push({
        timestamp: Date.now(),
        type: 'thinking',
        thinkingContent: content,
        thinkingTruncated: truncated,
        durationMs: elapsedMs,  // Time since processing started
      });
      processingState.thinkingBlockCount++;
      processingState.status = 'thinking';
      console.log(`[Activity] Thinking block added (${content.length} chars), total: ${processingState.activityLog.length} entries`);
    };

    // Helper to add tool start to activity log
    const logToolStart = (toolName: string) => {
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
    const logToolComplete = () => {
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

        // Update Message 1: Status panel
        if (statusMsgTs) {
          try {
            await withSlackRetry(
              () =>
                client.chat.update({
                  channel: channelId,
                  ts: statusMsgTs,
                  blocks: buildStatusPanelBlocks({
                    status: processingState.status,
                    mode: session.mode,
                    model: processingState.model,
                    currentTool: processingState.currentTool,
                    toolsCompleted: processingState.toolsCompleted,
                    elapsedMs,
                    conversationKey,
                    spinner,
                    rateLimitHits: processingState.rateLimitHits,
                  }),
                  text: 'Claude is working...',
                }),
              { onRateLimit: handleRateLimit }
            );
          } catch (error) {
            console.error('Error updating status panel:', error);
          }
        }

        // Update Message 2: Activity log
        if (activityLogMsgTs) {
          try {
            await withSlackRetry(
              () =>
                client.chat.update({
                  channel: channelId,
                  ts: activityLogMsgTs,
                  text: buildActivityLogText(processingState.activityLog, true),
                }),
              { onRateLimit: handleRateLimit }
            );
          } catch (error) {
            console.error('Error updating activity log:', error);
          }
        }
      });

      processingState.lastUpdateTime = now;
    };

    // Periodic timer to update spinner even when no events are firing
    const spinnerTimer = setInterval(() => {
      updateStatusMessages();
    }, STATUS_UPDATE_INTERVAL);

    for await (const msg of claudeQuery) {
      // Capture assistant message ID for message mapping (point-in-time forking)
      if (msg.type === 'assistant' && (msg as any).message?.id) {
        currentAssistantMessageId = (msg as any).message.id;
        console.log(`[Mapping] Captured assistant message ID: ${currentAssistantMessageId}`);
      }

      // Capture session ID and model from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        newSessionId = (msg as any).session_id;
        modelName = (msg as any).model;
        processingState.model = modelName;
        console.log(`Session initialized: ${newSessionId}, model: ${modelName}`);

        // Update model in active query for abort handler
        const activeQuery = activeQueries.get(conversationKey);
        if (activeQuery) {
          activeQuery.model = modelName;
        }

        // Trigger immediate update with model name
        processingState.lastUpdateTime = 0; // Force update
        await updateStatusMessages();
      }

      // Handle stream_event for real-time activity tracking
      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;

        // Thinking block started
        if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          processingState.currentThinkingIndex = event.index;
          processingState.currentThinkingContent = '';
          processingState.status = 'thinking';
        }

        // Thinking content streaming
        if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          processingState.currentThinkingContent += event.delta.thinking || '';
        }

        // Thinking block completed - add to activity log
        if (event?.type === 'content_block_stop' &&
            processingState.currentThinkingIndex === event.index &&
            processingState.currentThinkingContent) {
          logThinking(processingState.currentThinkingContent);
          processingState.currentThinkingContent = '';
          processingState.currentThinkingIndex = null;
          await updateStatusMessages();
        }

        // Tool use started
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          processingState.currentToolUseIndex = event.index;
          logToolStart(event.content_block.name);
          await updateStatusMessages();
        }

        // Tool use completed (content_block_stop for tool_use block)
        if (event?.type === 'content_block_stop' &&
            processingState.currentToolUseIndex === event.index &&
            processingState.currentTool) {
          logToolComplete();
          processingState.currentToolUseIndex = null;
          await updateStatusMessages();
        }

        // Text block started - model is responding (no thinking/tools needed)
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
          if (processingState.status === 'starting') {
            processingState.status = 'thinking'; // Show as "thinking" even for direct text response
            await updateStatusMessages();
          }
        }
      }

      // Handle assistant content
      if (msg.type === 'assistant' && 'content' in msg) {
        const content = (msg as any).content;
        if (typeof content === 'string') {
          fullResponse += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              fullResponse += block.text;
            }
          }
        }
      }

      // Handle result messages (final response with stats)
      if (msg.type === 'result') {
        const resultMsg = msg as any;

        if (resultMsg.result) {
          fullResponse = resultMsg.result;
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

    // Stop the spinner timer now that processing is complete
    clearInterval(spinnerTimer);

    // Calculate context percentage using input tokens + cache read tokens
    // This gives accurate context utilization since cached tokens are in the context window
    const totalContextTokens = (processingState.inputTokens || 0) + (processingState.cacheReadInputTokens || 0);
    const contextPercent = processingState.contextWindow && totalContextTokens > 0
      ? Math.round((totalContextTokens / processingState.contextWindow) * 100)
      : undefined;

    // Final elapsed time
    const finalDurationMs = processingState.durationMs ?? (Date.now() - processingState.startTime);

    // Update both messages to completion state (only if not aborted)
    if (!isAborted(conversationKey)) {
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        // Update Message 1: Final status panel with stats
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
                  elapsedMs: finalDurationMs,
                  inputTokens: processingState.inputTokens,
                  outputTokens: processingState.outputTokens,
                  contextPercent,
                  costUsd: processingState.costUsd,
                  conversationKey,
                  rateLimitHits: processingState.rateLimitHits,
                }),
                text: 'Complete',
              })
            );
          } catch (error) {
            console.error('Error updating status panel to complete:', error);
          }
        }

        // Update Message 2: Collapse activity log to summary with buttons
        if (activityLogMsgTs) {
          try {
            await withSlackRetry(() =>
              client.chat.update({
                channel: channelId,
                ts: activityLogMsgTs,
                blocks: buildCollapsedActivityBlocks(
                  processingState.thinkingBlockCount,
                  processingState.toolsCompleted,
                  finalDurationMs,
                  activityLogKey
                ),
                text: `Activity: ${processingState.thinkingBlockCount} thinking + ${processingState.toolsCompleted} tools`,
              })
            );
          } catch (error) {
            console.error('Error updating activity log to complete:', error);
          }
        }
      });

      // Save activity log for modal/download (keyed by message, not conversation)
      console.log(`[Activity] Saving activity log for ${activityLogKey}: ${processingState.activityLog.length} entries`);
      await saveActivityLog(activityLogKey, processingState.activityLog);
    }

    // Post complete response (only if not aborted and we have content)
    // Use postSplitResponse to handle long messages that exceed Slack's limits
    if (!isAborted(conversationKey) && fullResponse) {
      const postedMessages = await postSplitResponse(
        client,
        channelId,
        markdownToSlack(fullResponse),
        threadTs
      );

      // Link assistant message ID to Slack timestamps for message mapping (main channel only)
      // This enables point-in-time thread forking for future threads
      if (currentAssistantMessageId && postedMessages.length > 0 && !threadTs && originalTs) {
        const userMessageTs = originalTs;  // Original user message timestamp

        // Map ALL split message timestamps to the same SDK message ID
        postedMessages.forEach((slackMsg, index) => {
          const isFirst = index === 0;

          saveMessageMapping(channelId, slackMsg.ts, {
            sdkMessageId: currentAssistantMessageId!,
            type: 'assistant',
            parentSlackTs: isFirst ? userMessageTs : undefined,  // Only first links to user message
            isContinuation: !isFirst,  // Mark continuations
          });

          console.log(`[Mapping] Linked Slack ts ${slackMsg.ts} → SDK ${currentAssistantMessageId}${!isFirst ? ' (continuation)' : ''}`);
        });
      }

      // Check if in plan mode and Claude is asking to proceed
      // If so, add plan approval buttons
      if (session.mode === 'plan' && isPlanApprovalPrompt(fullResponse)) {
        try {
          await withSlackRetry(() =>
            client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: buildPlanApprovalBlocks({ conversationKey }),
              text: 'Ready to proceed? Choose how to execute the plan.',
            })
          );
        } catch (error) {
          console.error('Error posting plan approval buttons:', error);
        }
      }
    }

    // Remove eyes reaction
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

    // Save session (handle threads differently)
    if (newSessionId) {
      if (threadTs) {
        // Save to thread session
        saveThreadSession(channelId, threadTs, { sessionId: newSessionId });
      } else {
        // Save to main session
        saveSession(channelId, { sessionId: newSessionId });
      }
    }

  } catch (error: any) {
    console.error('Error streaming Claude response:', error);

    // Update both messages to error state (only if not aborted)
    if (!isAborted(conversationKey)) {
      const mutex = getUpdateMutex(conversationKey);
      await mutex.runExclusive(async () => {
        if (isAborted(conversationKey)) return;

        // Update status panel to error
        if (statusMsgTs) {
          try {
            await client.chat.update({
              channel: channelId,
              ts: statusMsgTs,
              blocks: buildStatusPanelBlocks({
                status: 'error',
                mode: session.mode,
                toolsCompleted: processingState.toolsCompleted,
                elapsedMs: Date.now() - processingState.startTime,
                conversationKey,
                errorMessage: error.message,
              }),
              text: `Error: ${error.message}`,
            });
          } catch (e) {
            console.error('Error updating status panel to error:', e);
          }
        }

        // Update activity log to show error
        if (activityLogMsgTs) {
          try {
            processingState.activityLog.push({
              timestamp: Date.now(),
              type: 'error',
              message: error.message,
            });
            await client.chat.update({
              channel: channelId,
              ts: activityLogMsgTs,
              text: buildActivityLogText(processingState.activityLog, false),
            });
          } catch (e) {
            console.error('Error updating activity log to error:', e);
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

        // Update Message 1: Status panel to aborted
        try {
          await client.chat.update({
            channel: channelId,
            ts: active.statusMsgTs,
            blocks: buildStatusPanelBlocks({
              status: 'aborted',
              mode: active.mode,
              model: active.model,
              toolsCompleted: active.processingState.toolsCompleted,
              elapsedMs,
              conversationKey,
            }),
            text: `${active.model || 'Claude'} | ${active.mode} | aborted`,
          });
        } catch (error) {
          console.error('Error updating status panel to aborted:', error);
        }

        // Update Message 2: Activity log to aborted
        try {
          await client.chat.update({
            channel: channelId,
            ts: active.activityLogMsgTs,
            text: buildActivityLogText(active.processingState.activityLog, false) + '\n:octagonal_sign: *Aborted by user*',
          });
        } catch (error) {
          console.error('Error updating activity log to aborted:', error);
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
    // Update session with new mode
    saveSession(channelId, { mode });

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

  const bodyWithChannel = body as typeof body & { channel?: { id: string }; message?: { ts: string } };
  const channelId = bodyWithChannel.channel?.id;
  if (!channelId) return;

  console.log(`Model button clicked: ${modelId} for channel: ${channelId}`);

  // Get model display name for confirmation
  const modelInfo = await getModelInfo(modelId);
  const displayName = modelInfo?.displayName || modelId;

  // Save to session
  saveSession(channelId, { model: modelId });

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

// Handle plan approval "Proceed (auto-accept)" button
app.action(/^plan_approve_auto_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^plan_approve_auto_(.+)$/);
  const conversationKey = match ? match[1] : '';

  // Extract channel and thread from conversation key
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan approve (auto) clicked for: ${conversationKey}`);

  const bodyWithChannel = body as any;

  // Update approval message to show selection
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `✅ Proceeding with auto-accept mode...`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating plan approval message:', error);
    }
  }

  // Update session mode to bypassPermissions
  saveSession(channelId, { mode: 'bypassPermissions' });

  // Send "proceed" message to Claude
  // Use threadTs as originalTs so eyes reaction is managed on the thread
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: threadTs,  // Add eyes to thread parent
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Handle plan approval "Proceed (manual approve)" button
app.action(/^plan_approve_manual_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^plan_approve_manual_(.+)$/);
  const conversationKey = match ? match[1] : '';

  // Extract channel and thread from conversation key
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan approve (manual) clicked for: ${conversationKey}`);

  const bodyWithChannel = body as any;

  // Update approval message to show selection
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `✅ Proceeding with manual approval mode...`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating plan approval message:', error);
    }
  }

  // Update session mode to default (ask)
  saveSession(channelId, { mode: 'default' });

  // Send "proceed" message to Claude
  // Use threadTs as originalTs so eyes reaction is managed on the thread
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'Yes, proceed with the plan.',
    originalTs: threadTs,  // Add eyes to thread parent
    threadTs,
    client,
    skipConcurrentCheck: true,
  });
});

// Handle plan approval "Reject" button
app.action(/^plan_reject_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^plan_reject_(.+)$/);
  const conversationKey = match ? match[1] : '';

  // Extract channel and thread from conversation key
  const [channelId, threadTs] = conversationKey.includes('_')
    ? conversationKey.split('_')
    : [conversationKey, undefined];

  console.log(`Plan reject clicked for: ${conversationKey}`);

  const bodyWithChannel = body as any;

  // Update approval message to show rejection
  if (bodyWithChannel.channel?.id && bodyWithChannel.message?.ts) {
    try {
      await client.chat.update({
        channel: bodyWithChannel.channel.id,
        ts: bodyWithChannel.message.ts,
        text: `❌ Plan rejected. Tell Claude what to change.`,
        blocks: [],
      });
    } catch (error) {
      console.error('Error updating plan rejection message:', error);
    }
  }

  // Keep mode as plan, send rejection message to Claude
  // Use threadTs as originalTs so eyes reaction is managed on the thread
  await handleMessage({
    channelId,
    userId: bodyWithChannel.user?.id,
    userText: 'No, I want to change the plan. Please wait for my feedback.',
    originalTs: threadTs,  // Add eyes to thread parent
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
// Activity Log Modal and Download Handlers
// ============================================================================

const MODAL_PAGE_SIZE = 15;  // Entries per page for modal

// Handle "View Log" button click - opens modal with activity log
app.action(/^view_activity_log_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^view_activity_log_(.+)$/);
  const conversationKey = match ? match[1] : '';

  console.log(`View activity log clicked for: ${conversationKey}`);

  const bodyWithTrigger = body as any;
  const triggerId = bodyWithTrigger.trigger_id;

  if (!triggerId) {
    console.error('No trigger_id found for activity log modal');
    return;
  }

  // Get activity log from storage
  console.log(`[DEBUG] Fetching activity log for key: "${conversationKey}"`);
  const activityLog = await getActivityLog(conversationKey);
  console.log(`[DEBUG] Activity log result: ${activityLog ? activityLog.length + ' entries' : 'null'}`);

  if (!activityLog) {
    // Log not found - session was cleared or bot restarted
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
      console.error('Error opening activity log error modal:', error);
    }
    return;
  }

  if (activityLog.length === 0) {
    // Log exists but is empty - no tools or thinking blocks were used
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
              text: ':information_source: No activity to display.\n\nClaude responded directly without using any tools or extended thinking.',
            },
          }],
        },
      });
    } catch (error) {
      console.error('Error opening activity log empty modal:', error);
    }
    return;
  }

  // Open modal with first page
  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: buildActivityLogModalView(activityLog, 1, totalPages, conversationKey),
    });
  } catch (error) {
    console.error('Error opening activity log modal:', error);
  }
});

// Handle pagination buttons in modal
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

  let metadata: { conversationKey: string };
  try {
    metadata = JSON.parse(privateMetadata);
  } catch (e) {
    console.error('Error parsing private_metadata:', e);
    return;
  }

  const { conversationKey } = metadata;

  // Get activity log from storage
  const activityLog = await getActivityLog(conversationKey);
  if (!activityLog) {
    console.error('Activity log not found for pagination');
    return;
  }

  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);

  // Update modal with new page (in-place pagination)
  try {
    await client.views.update({
      view_id: viewId,
      view: buildActivityLogModalView(activityLog, page, totalPages, conversationKey),
    });
  } catch (error) {
    console.error('Error updating activity log modal page:', error);
  }
});

// Handle "Download .txt" button click - uploads activity log as file
app.action(/^download_activity_log_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();

  const actionId = 'action_id' in action ? action.action_id : '';
  const match = actionId.match(/^download_activity_log_(.+)$/);
  const conversationKey = match ? match[1] : '';

  console.log(`Download activity log clicked for: ${conversationKey}`);

  const bodyWithChannel = body as any;
  const channelId = bodyWithChannel.channel?.id;
  const threadTs = bodyWithChannel.message?.thread_ts;

  if (!channelId) {
    console.error('No channel_id found for activity log download');
    return;
  }

  // Get activity log from storage
  const activityLog = await getActivityLog(conversationKey);

  if (!activityLog) {
    // Log not found - session was cleared or bot restarted
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithChannel.user?.id || 'unknown',
        text: ':warning: Activity log is no longer available.\n\nThis can happen if the session was cleared or the bot was restarted.',
      });
    } catch (error) {
      console.error('Error posting activity log unavailable message:', error);
    }
    return;
  }

  if (activityLog.length === 0) {
    // Log exists but is empty - no tools or thinking blocks were used
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: bodyWithChannel.user?.id || 'unknown',
        text: ':information_source: No activity to download.\n\nClaude responded directly without using any tools or extended thinking.',
      });
    } catch (error) {
      console.error('Error posting activity log empty message:', error);
    }
    return;
  }

  // Format as plain text with FULL thinking content
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`Activity Log for ${conversationKey}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('='.repeat(60));
  lines.push('');

  for (const entry of activityLog) {
    const timestamp = new Date(entry.timestamp).toISOString();
    const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';

    if (entry.type === 'thinking') {
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
    } else if (entry.type === 'error') {
      lines.push(`[${timestamp}] ERROR: ${entry.message || 'unknown'}`);
    }
  }

  const content = lines.join('\n');
  const filename = `activity-log-${conversationKey.replace(/[^a-zA-Z0-9_-]/g, '-')}.txt`;

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
    console.error('Error uploading activity log file:', error);
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

export async function startBot() {
  // Refresh model cache on startup
  console.log('Refreshing model cache...');
  await refreshModelCache();

  await app.start();
  console.log('Bot is running!');
}
