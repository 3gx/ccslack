/**
 * Message sync module - single source of truth for syncing terminal messages to Slack.
 * Uses turn-based posting to match bot output fidelity.
 * Used by both /ff (fast-forward) and /watch commands.
 */

import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import {
  readNewMessages,
  SessionFileMessage,
  extractTextContent,
  groupMessagesByTurn,
  Turn,
  TurnSegment,
  extractPlanFilePathFromMessage,
  hasExitPlanMode,
} from './session-reader.js';
import {
  getMessageMapUuids,
  saveMessageMapping,
  mergeActivityLog,
  isSlackOriginatedUserUuid,
  generateSegmentKey,
  saveSegmentActivityLog,
  SlackMessageMapping,
} from './session-manager.js';
import {
  readActivityLog,
  ActivityEntry,
} from './session-event-stream.js';
import { buildLiveActivityBlocks } from './blocks.js';
import { withSlackRetry, withInfiniteRetry, sleep } from './retry.js';
import { truncateWithClosedFormatting, uploadMarkdownWithResponse } from './streaming.js';

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
  postTextMessage?: (state: MessageSyncState, msg: SessionFileMessage, isLastMessage?: boolean) => Promise<boolean>;
  /** Character limit for text responses */
  charLimit?: number;
  /** Whether to strip empty code fence wrappers */
  stripEmptyTag?: boolean;
  /** Activity message ts per turn (for update-in-place). Key: userInput UUID, Value: Slack ts */
  activityMessages?: Map<string, string>;
  /** Callback when plan file path detected */
  onPlanFileDetected?: (path: string) => void | Promise<void>;
  /** Callback when ExitPlanMode detected with plan path */
  onExitPlanMode?: (planFilePath: string | null) => Promise<void>;
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

const SESSIONS_FILE = './sessions.json';

/**
 * Get the full messageMap for a channel (for finding existing activity Slack ts).
 */
function getMessageMap(channelId: string): Record<string, SlackMessageMapping> {
  if (!fs.existsSync(SESSIONS_FILE)) {
    return {};
  }

  try {
    const content = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const store = JSON.parse(content);
    return store.channels?.[channelId]?.messageMap ?? {};
  } catch {
    return {};
  }
}

/**
 * Get activity entries for a turn based on timestamp range.
 * Filters activity from turn start (userInput) to turn end (next turn or Infinity).
 */
function getActivityForTurn(
  turn: Turn,
  allTurns: Turn[],
  turnIndex: number,
  fullActivityLog: ActivityEntry[]
): ActivityEntry[] {
  const turnStart = new Date(turn.userInput.timestamp).getTime();

  // Find next turn's start timestamp (or Infinity if last turn)
  let turnEnd = Infinity;
  if (turnIndex + 1 < allTurns.length) {
    turnEnd = new Date(allTurns[turnIndex + 1].userInput.timestamp).getTime();
  }

  return fullActivityLog.filter(entry =>
    entry.timestamp >= turnStart && entry.timestamp < turnEnd
  );
}

/**
 * Calculate turn duration from userInput to last textOutput timestamp.
 * Falls back to activity span if no text output.
 */
function calculateTurnDuration(turn: Turn, activityEntries: ActivityEntry[]): number {
  // Prefer turn span: userInput timestamp → last textOutput timestamp
  // This matches bot's Date.now() - processingState.startTime approach
  if (turn.segments.length > 0) {
    const start = new Date(turn.userInput.timestamp).getTime();
    const lastSegment = turn.segments[turn.segments.length - 1];
    const end = new Date(lastSegment.textOutput.timestamp).getTime();
    return end - start;
  }

  // Fallback for activity-only turns (no text output)
  if (activityEntries.length === 0) return 0;
  const first = activityEntries[0].timestamp;
  const last = activityEntries[activityEntries.length - 1].timestamp;
  return last - first;
}

/**
 * Sync messages from a session file to Slack, starting at the given offset.
 * Uses turn-based posting to match bot output fidelity.
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
    charLimit = 500,
    stripEmptyTag = false,
    activityMessages,
    onPlanFileDetected,
    onExitPlanMode,
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

  // 1b. Read full activity log once (uses FIFO tool matching for tool_complete with duration)
  const fullActivityLog = await readActivityLog(filePath);
  console.log(`[MessageSync] Loaded ${fullActivityLog.length} activity entries from session`);

  // 2. Group messages into turns
  const turns = groupMessagesByTurn(messages);
  console.log(`[MessageSync] Grouped ${messages.length} messages into ${turns.length} turns`);

  // 3. Get deduplication state
  const alreadyPosted = getMessageMapUuids(state.channelId);
  const messageMap = getMessageMap(state.channelId);

  // 4. Filter turns - skip only if ALL messages in turn already posted
  // (partial turns still need processing for recovery/update)
  const turnsToProcess = turns.filter(turn =>
    turn.allMessageUuids.some(uuid => !alreadyPosted.has(uuid))
  );
  console.log(`[MessageSync] ${turnsToProcess.length} turns to process (${turns.length - turnsToProcess.length} fully posted)`);

  if (turnsToProcess.length === 0) {
    return {
      newOffset,
      syncedCount: 0,
      totalToSync: 0,
      wasAborted: false,
      allSucceeded: true,
    };
  }

  // 5. Post each turn
  let syncedCount = 0;
  let wasAborted = false;
  let allSucceeded = true;

  for (let i = 0; i < turnsToProcess.length; i++) {
    // Check abort flag
    if (isAborted?.()) {
      wasAborted = true;
      console.log(`[MessageSync] Sync aborted at turn ${i + 1}/${turnsToProcess.length}`);
      break;
    }

    const turn = turnsToProcess[i];
    const turnIndex = turns.indexOf(turn);
    const turnActivity = getActivityForTurn(turn, turns, turnIndex, fullActivityLog);

    console.log(`[MessageSync] Processing turn ${i + 1}/${turnsToProcess.length}: user=${turn.userInput.uuid}, segments=${turn.segments.length}, trailingActivity=${turn.trailingActivity.length}, activityEntries=${turnActivity.length}`);

    const isFinalTurn = (i === turnsToProcess.length - 1);
    const result = await postTurn(
      state,
      turn,
      turnActivity,
      alreadyPosted,
      messageMap,
      { charLimit, stripEmptyTag, infiniteRetry, postTextMessage, activityMessages, onPlanFileDetected, onExitPlanMode },
      isFinalTurn
    );

    if (result.success) {
      syncedCount += result.postedUuids.length;
      // Update alreadyPosted with newly posted UUIDs (for subsequent turns in same /ff run)
      for (const uuid of result.postedUuids) {
        alreadyPosted.add(uuid);
      }
    } else {
      allSucceeded = false;
    }

    // Progress callback (use last message in turn for display)
    if (onProgress) {
      // Get the last text output from segments, or trailing activity, or user input
      const lastSegmentOutput = turn.segments.length > 0
        ? turn.segments[turn.segments.length - 1].textOutput
        : null;
      const lastTrailing = turn.trailingActivity.length > 0
        ? turn.trailingActivity[turn.trailingActivity.length - 1]
        : null;
      const displayMsg = lastSegmentOutput || lastTrailing || turn.userInput;
      await onProgress(syncedCount, turnsToProcess.length, displayMsg);
    }

    // Pacing delay between turns (skip on last)
    if (pacingDelayMs > 0 && i < turnsToProcess.length - 1) {
      await sleep(pacingDelayMs);
    }
  }

  return {
    newOffset,
    syncedCount,
    totalToSync: turnsToProcess.length,
    wasAborted,
    allSucceeded,
  };
}

/**
 * Get activity entries for a specific segment based on timestamp range.
 * Filters activity from previous segment end (or turn start) to this segment's text output.
 */
function getActivityForSegment(
  segmentIndex: number,
  segments: TurnSegment[],
  turnStartTime: number,
  allTurnActivity: ActivityEntry[]
): ActivityEntry[] {
  // Determine segment start time
  const segmentStart = segmentIndex === 0
    ? turnStartTime
    : new Date(segments[segmentIndex - 1].textOutput.timestamp).getTime();

  // Determine segment end time (this segment's text output timestamp)
  const segment = segments[segmentIndex];
  const segmentEnd = new Date(segment.textOutput.timestamp).getTime();

  return allTurnActivity.filter(entry =>
    entry.timestamp >= segmentStart && entry.timestamp <= segmentEnd
  );
}

/**
 * Get trailing activity (after last segment) for in-progress turns.
 */
function getTrailingActivity(
  segments: TurnSegment[],
  turnStartTime: number,
  allTurnActivity: ActivityEntry[]
): ActivityEntry[] {
  // Trailing activity starts after the last segment's text output (or turn start if no segments)
  const trailingStart = segments.length > 0
    ? new Date(segments[segments.length - 1].textOutput.timestamp).getTime()
    : turnStartTime;

  return allTurnActivity.filter(entry => entry.timestamp > trailingStart);
}

/**
 * Post a complete turn to Slack with INTERLEAVED activity + text per segment.
 *
 * Key design (CLI-fidelity): Each segment gets its own activity message followed by text.
 * Trailing activity (in-progress turns) uses update-in-place for /watch live updates.
 *
 * Flow:
 * 1. Post user input
 * 2. For each segment:
 *    a. Post activity message (new, not update-in-place)
 *    b. Post text message
 * 3. Post/update trailing activity (for in-progress turns)
 */
async function postTurn(
  state: MessageSyncState,
  turn: Turn,
  activityEntries: ActivityEntry[],
  alreadyPosted: Set<string>,
  _messageMap: Record<string, SlackMessageMapping>,  // Kept for signature compatibility
  options: {
    charLimit: number;
    stripEmptyTag?: boolean;
    infiniteRetry?: boolean;
    postTextMessage?: (state: MessageSyncState, msg: SessionFileMessage, isLastMessage?: boolean) => Promise<boolean>;
    activityMessages?: Map<string, string>;
    onPlanFileDetected?: (path: string) => void | Promise<void>;
    onExitPlanMode?: (planFilePath: string | null) => Promise<void>;
  },
  isFinalTurn: boolean = false
): Promise<{ success: boolean; postedUuids: string[] }> {
  const postedUuids: string[] = [];
  const { charLimit, stripEmptyTag, infiniteRetry = false, postTextMessage, activityMessages, onPlanFileDetected, onExitPlanMode } = options;
  const turnKey = turn.userInput.uuid;
  const activityLogKey = state.conversationKey;
  // messageTs for segment keys: use threadTs if in thread, conversationKey as fallback
  const segmentMessageTs = state.threadTs || state.conversationKey;
  const turnStartTime = new Date(turn.userInput.timestamp).getTime();

  // Scan all messages in turn for plan file path and ExitPlanMode
  // Only trigger ExitPlanMode callback for NEW messages (not already posted)
  // to avoid showing plan twice when new messages are added to the same turn
  let detectedPlanPath: string | null = null;
  let exitPlanModeFound = false;

  // Check activity messages in segments
  for (const segment of turn.segments) {
    for (const activityMsg of segment.activityMessages) {
      const path = extractPlanFilePathFromMessage(activityMsg);
      if (path) detectedPlanPath = path;
      if (hasExitPlanMode(activityMsg) && !alreadyPosted.has(activityMsg.uuid)) {
        exitPlanModeFound = true;
      }
    }
  }

  // Check trailing activity
  for (const activityMsg of turn.trailingActivity) {
    const path = extractPlanFilePathFromMessage(activityMsg);
    if (path) detectedPlanPath = path;
    if (hasExitPlanMode(activityMsg) && !alreadyPosted.has(activityMsg.uuid)) {
      exitPlanModeFound = true;
    }
  }

  // Notify callbacks
  if (detectedPlanPath && onPlanFileDetected) {
    await onPlanFileDetected(detectedPlanPath);
  }

  // 1. Post user input (skip if already posted - partial turn recovery)
  if (!alreadyPosted.has(turn.userInput.uuid)) {
    const inputResult = await postUserInput(state, turn.userInput, infiniteRetry, charLimit);
    if (inputResult?.ts) {
      await saveMessageMapping(state.channelId, inputResult.ts, {
        sdkMessageId: turn.userInput.uuid,
        sessionId: state.sessionId,
        type: 'user',
      });
      postedUuids.push(turn.userInput.uuid);
    }
  }

  // 2. Post INTERLEAVED activity + text for each segment
  for (let i = 0; i < turn.segments.length; i++) {
    const segment = turn.segments[i];

    // 2a. Get activity entries for THIS segment
    const segmentActivity = getActivityForSegment(i, turn.segments, turnStartTime, activityEntries);

    // 2b. Post activity message for this segment (if there's activity and not already posted)
    if (segmentActivity.length > 0) {
      // Check if segment activity messages are already posted
      const segmentActivityAlreadyPosted = segment.activityMessages.every(m => alreadyPosted.has(m.uuid));

      if (!segmentActivityAlreadyPosted) {
        // Generate unique segment key for View Log isolation
        const segmentKey = generateSegmentKey(state.channelId, segmentMessageTs);

        // Save segment activity before posting
        saveSegmentActivityLog(segmentKey, segmentActivity);

        // isLastMessage: true only for the final segment of the final turn (same as text posting)
        const isLastSegment = isFinalTurn && (i === turn.segments.length - 1);

        // Post NEW activity message for this segment (not update-in-place)
        const blocks = buildLiveActivityBlocks(
          segmentActivity,
          segmentKey,
          false,  // not in-progress
          isLastSegment,  // Fork button only on final segment of final turn
          { threadTs: state.threadTs, conversationKey: state.conversationKey }
        );
        const activityResult = await postActivitySummary(state, blocks, infiniteRetry);

        if (activityResult?.ts) {
          // Save activity log (unified with bot)
          await mergeActivityLog(activityLogKey, segmentActivity);
          console.log(`[MessageSync] Posted segment activity: ${segmentActivity.length} entries, key: ${segmentKey}`);

          // Track activity messages as posted
          for (const activityMsg of segment.activityMessages) {
            if (!alreadyPosted.has(activityMsg.uuid)) {
              const mappingKey = `${activityResult.ts}_${activityMsg.uuid}`;
              await saveMessageMapping(state.channelId, mappingKey, {
                sdkMessageId: activityMsg.uuid,
                sessionId: state.sessionId,
                type: 'assistant',
              });
              postedUuids.push(activityMsg.uuid);
            }
          }
        }
      }
    }

    // 2c. Post text output for this segment (skip if already posted)
    if (!alreadyPosted.has(segment.textOutput.uuid)) {
      let textSuccess = false;
      // isLastMessage: true only for the final segment of the final turn
      const isLastMessage = isFinalTurn && (i === turn.segments.length - 1);

      if (postTextMessage) {
        if (infiniteRetry) {
          textSuccess = await withInfiniteRetry(
            () => postTextMessage(state, segment.textOutput, isLastMessage),
            {
              baseDelayMs: 3000,
              maxDelayMs: 30000,
              onRetry: (error, attempt, delayMs) => {
                console.log(`[MessageSync] Text ${segment.textOutput.uuid} failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
              },
            }
          );
        } else {
          textSuccess = await postTextMessage(state, segment.textOutput, isLastMessage);
        }
      } else {
        const textResult = await postTextResponse(state, segment.textOutput, { charLimit, stripEmptyTag }, infiniteRetry);
        textSuccess = !!textResult?.ts;

        if (textResult?.ts) {
          await saveMessageMapping(state.channelId, textResult.ts, {
            sdkMessageId: segment.textOutput.uuid,
            sessionId: state.sessionId,
            type: 'assistant',
          });
        }
      }

      if (textSuccess) {
        postedUuids.push(segment.textOutput.uuid);
      }
    }
  }

  // 3. Post/update trailing activity (for in-progress turns only)
  // Trailing activity uses update-in-place for /watch live updates
  const trailingActivity = getTrailingActivity(turn.segments, turnStartTime, activityEntries);
  if (trailingActivity.length > 0) {
    // Check if we already have a trailing activity message for this turn
    const existingTs = activityMessages?.get(turnKey);

    // Generate unique segment key for trailing activity
    // NOTE: For /watch, the same segment key should be used for updates
    // We store the segment key with the turn key for consistent updates
    const trailingSegmentKeyStorage = `${turnKey}_segmentKey`;
    let trailingSegmentKey = activityMessages?.get(trailingSegmentKeyStorage);
    if (!trailingSegmentKey) {
      trailingSegmentKey = generateSegmentKey(state.channelId, segmentMessageTs);
      activityMessages?.set(trailingSegmentKeyStorage, trailingSegmentKey);
    }

    // Update segment activity for View Log (so View Log shows latest even during updates)
    saveSegmentActivityLog(trailingSegmentKey, trailingActivity);

    const blocks = buildLiveActivityBlocks(
      trailingActivity,
      trailingSegmentKey,
      true,  // in-progress (live updates)
      false,  // no Fork button for in-progress trailing activity
      undefined  // no forkInfo needed
    );

    let activityTs: string | undefined;

    if (existingTs) {
      // UPDATE existing message (for /watch live updates)
      const updateResult = await updateActivitySummary(state, existingTs, blocks, infiniteRetry);
      if (updateResult.success) {
        activityTs = updateResult.ts;
      } else if (updateResult.messageNotFound) {
        console.log(`[MessageSync] Trailing activity message ${existingTs} was deleted, posting new`);
        const postResult = await postActivitySummary(state, blocks, infiniteRetry);
        activityTs = postResult?.ts;
      }
    } else {
      // POST new message
      const postResult = await postActivitySummary(state, blocks, infiniteRetry);
      activityTs = postResult?.ts;
    }

    // Store the ts for next poll
    if (activityTs) {
      activityMessages?.set(turnKey, activityTs);

      // Save activity log (unified with bot)
      await mergeActivityLog(activityLogKey, trailingActivity);
      console.log(`[MessageSync] Posted/updated trailing activity: ${trailingActivity.length} entries, key: ${trailingSegmentKey}`);

      // Track trailing activity messages as posted
      for (const activityMsg of turn.trailingActivity) {
        if (!alreadyPosted.has(activityMsg.uuid)) {
          const mappingKey = `${activityTs}_${activityMsg.uuid}`;
          await saveMessageMapping(state.channelId, mappingKey, {
            sdkMessageId: activityMsg.uuid,
            sessionId: state.sessionId,
            type: 'assistant',
          });
          postedUuids.push(activityMsg.uuid);
        }
      }
    }
  }

  // Trigger ExitPlanMode callback after all posting is done
  if (exitPlanModeFound && onExitPlanMode) {
    await onExitPlanMode(detectedPlanPath);
  }

  return { success: true, postedUuids };
}

/**
 * Post user input message with :inbox_tray: prefix.
 * Truncates long inputs to stay within charLimit.
 *
 * Skips messages that originated from Slack bot interactions (/ff should not
 * re-post user input that's already visible in Slack from @mention).
 */
async function postUserInput(
  state: MessageSyncState,
  msg: SessionFileMessage,
  infiniteRetry: boolean,
  charLimit: number
): Promise<{ ts: string } | null> {
  // Skip user messages that originated from Slack bot interactions
  // These are already visible in Slack (user typed @Claude Code ...)
  if (isSlackOriginatedUserUuid(state.channelId, msg.uuid, state.threadTs)) {
    console.log(`[MessageSync] Skipping Slack-originated user input: ${msg.uuid}`);
    return { ts: 'skipped' };  // Return success so it's not treated as a failure
  }

  const textContent = extractTextContent(msg);
  const prefix = ':inbox_tray: *Terminal Input*\n';

  // If content exceeds limit, upload .md file (no PNG for user input)
  if (textContent.length > charLimit) {
    const uploadWithMd = async () => {
      try {
        const uploaded = await uploadMarkdownWithResponse(
          state.client,
          state.channelId,
          textContent,  // Original content for .md file
          prefix + textContent,  // Full text with prefix (function handles truncation)
          state.threadTs,
          undefined,  // No userId available in MessageSyncState
          charLimit
        );
        return uploaded?.ts ? { ts: uploaded.ts } : null;
      } catch (error) {
        console.error(`[MessageSync] Failed to upload user input:`, error);
        return null;
      }
    };

    if (infiniteRetry) {
      return await withInfiniteRetry(uploadWithMd, {
        baseDelayMs: 3000,
        maxDelayMs: 30000,
        onRetry: (error, attempt, delayMs) => {
          console.log(`[MessageSync] User input ${msg.uuid} upload failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
        },
      });
    }
    return await uploadWithMd();
  }

  // Short content: simple text post (no file attachment)
  const displayText = prefix + textContent;

  const post = async () => {
    try {
      const result = await withSlackRetry(() =>
        state.client.chat.postMessage({
          channel: state.channelId,
          thread_ts: state.threadTs,
          text: displayText,
        })
      ) as { ts?: string };

      return { ts: result?.ts ?? '' };
    } catch (error) {
      console.error(`[MessageSync] Failed to post user input:`, error);
      return null;
    }
  };

  if (infiniteRetry) {
    return await withInfiniteRetry(post, {
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      onRetry: (error, attempt, delayMs) => {
        console.log(`[MessageSync] User input ${msg.uuid} failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
      },
    });
  }

  return await post();
}

/**
 * Post activity summary with View Log and Download buttons.
 */
async function postActivitySummary(
  state: MessageSyncState,
  blocks: any[],
  infiniteRetry: boolean
): Promise<{ ts: string } | null> {
  const post = async () => {
    try {
      const result = await withSlackRetry(() =>
        state.client.chat.postMessage({
          channel: state.channelId,
          thread_ts: state.threadTs,
          blocks,
          text: 'Activity summary',
        })
      ) as { ts?: string };

      return { ts: result?.ts ?? '' };
    } catch (error) {
      console.error(`[MessageSync] Failed to post activity summary:`, error);
      return null;
    }
  };

  if (infiniteRetry) {
    return await withInfiniteRetry(post, {
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      onRetry: (error, attempt, delayMs) => {
        console.log(`[MessageSync] Activity summary failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
      },
    });
  }

  return await post();
}

/**
 * Result of updateActivitySummary - distinguishes between success, recoverable failure, and message_not_found.
 */
type UpdateActivityResult =
  | { success: true; ts: string }
  | { success: false; messageNotFound: boolean };

/**
 * Check if an error is a Slack "message_not_found" error.
 */
function isMessageNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as { data?: { error?: string }; message?: string };
    return err.data?.error === 'message_not_found' ||
           (typeof err.message === 'string' && err.message.includes('message_not_found'));
  }
  return false;
}

/**
 * Update existing activity summary message (for partial turn recovery).
 * Uses chat.update instead of chat.postMessage.
 * Returns messageNotFound: true if the message was deleted, allowing caller to post a new one.
 */
async function updateActivitySummary(
  state: MessageSyncState,
  existingTs: string,
  blocks: any[],
  infiniteRetry: boolean
): Promise<UpdateActivityResult> {
  const update = async (): Promise<UpdateActivityResult> => {
    try {
      await withSlackRetry(() =>
        state.client.chat.update({
          channel: state.channelId,
          ts: existingTs,
          blocks,
          text: 'Activity summary updated',
        })
      );
      return { success: true, ts: existingTs };
    } catch (error) {
      const notFound = isMessageNotFoundError(error);
      if (notFound) {
        console.log(`[MessageSync] Activity message ${existingTs} not found, will post new message`);
      } else {
        console.error(`[MessageSync] Failed to update activity:`, error);
      }
      return { success: false, messageNotFound: notFound };
    }
  };

  if (infiniteRetry) {
    // For infinite retry, we should NOT retry message_not_found errors
    // as they will never succeed. Use a custom retry that stops on message_not_found.
    let lastResult: UpdateActivityResult = { success: false, messageNotFound: false };
    try {
      await withInfiniteRetry(
        async () => {
          lastResult = await update();
          if (lastResult.success) {
            return lastResult;
          }
          // Don't retry message_not_found - it's a permanent failure
          if (lastResult.messageNotFound) {
            return lastResult;
          }
          // Throw to trigger retry for other errors
          throw new Error('Update failed, retrying');
        },
        {
          baseDelayMs: 3000,
          maxDelayMs: 30000,
          onRetry: (error, attempt, delayMs) => {
            console.log(`[MessageSync] Activity update failed (attempt ${attempt}), retrying in ${delayMs}ms`);
          },
        }
      );
    } catch {
      // If retry exhausted or threw, return last result
    }
    return lastResult;
  }

  return await update();
}

/**
 * Post text response message.
 */
async function postTextResponse(
  state: MessageSyncState,
  msg: SessionFileMessage,
  options: { charLimit: number; stripEmptyTag?: boolean },
  infiniteRetry: boolean
): Promise<{ ts: string } | null> {
  const textContent = extractTextContent(msg);
  if (!textContent.trim()) return null;

  // Truncate if needed
  const displayText = textContent.length <= options.charLimit
    ? textContent
    : textContent.slice(0, options.charLimit) + '...\n\n_Response truncated. See attachments for full response._';

  const post = async () => {
    try {
      const result = await withSlackRetry(() =>
        state.client.chat.postMessage({
          channel: state.channelId,
          thread_ts: state.threadTs,
          text: displayText,
        })
      ) as { ts?: string };

      return { ts: result?.ts ?? '' };
    } catch (error) {
      console.error(`[MessageSync] Failed to post text response:`, error);
      return null;
    }
  };

  if (infiniteRetry) {
    return await withInfiniteRetry(post, {
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      onRetry: (error, attempt, delayMs) => {
        console.log(`[MessageSync] Text response ${msg.uuid} failed (attempt ${attempt}), retrying in ${delayMs}ms:`, error);
      },
    });
  }

  return await post();
}
