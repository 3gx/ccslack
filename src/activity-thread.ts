/**
 * Thread-based activity posting for Slack bot.
 *
 * Provides functions to post activity entries as thread replies,
 * with support for batching, rate limiting, and .md attachments for long content.
 */

import { WebClient } from '@slack/web-api';
import {
  ActivityEntry,
  formatThreadActivityBatch,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
  formatThreadStartingMessage,
  formatThreadErrorMessage,
} from './blocks.js';
import { uploadMarkdownAndPngWithResponse } from './streaming.js';
import { withSlackRetry } from './retry.js';

/**
 * Default character limit for thread messages before truncation + attachment.
 */
const DEFAULT_THREAD_CHAR_LIMIT = 500;

/**
 * Get permalink URL for a message using Slack API.
 * Returns workspace-specific URL that works properly on iOS mobile app.
 * Falls back to manual URL construction if API call fails.
 */
export async function getMessagePermalink(
  client: WebClient,
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

/**
 * Post activity content to a thread reply.
 *
 * If fullMarkdown is provided and exceeds the limit, uploads as .md attachment.
 * Otherwise posts as a simple text message.
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID to post to
 * @param parentTs - Thread parent timestamp (user input message or activity message)
 * @param content - Formatted activity text (mrkdwn)
 * @param options - Optional settings
 * @returns Posted message info or null on failure
 */
export async function postActivityToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  options?: {
    fullMarkdown?: string;  // Full content for .md attachment if truncated
    charLimit?: number;     // Truncation threshold (default 500)
    threadTs?: string;      // If posting to existing Slack thread (nested)
    userId?: string;        // User ID for file uploads
  }
): Promise<{ ts: string } | null> {
  const charLimit = options?.charLimit ?? DEFAULT_THREAD_CHAR_LIMIT;
  const threadTs = options?.threadTs ?? parentTs;

  try {
    // If we have long content that needs .md attachment
    if (options?.fullMarkdown && options.fullMarkdown.length > charLimit) {
      const result = await uploadMarkdownAndPngWithResponse(
        client,
        channelId,
        options.fullMarkdown,
        content,
        threadTs,
        options?.userId,
        charLimit
      );
      return result?.ts ? { ts: result.ts } : null;
    }

    // Simple text message to thread
    const result = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: content,
      mrkdwn: true,
    });

    return result.ts ? { ts: result.ts as string } : null;
  } catch (error) {
    console.error('[activity-thread] Failed to post to thread:', error);
    return null;
  }
}

/**
 * Processing state interface for activity batching.
 * This mirrors the fields added to ProcessingState in slack-bot.ts.
 */
export interface ActivityBatchState {
  activityThreadMsgTs: string | null;      // Current thread message being edited
  activityBatch: ActivityEntry[];          // Entries waiting to post
  activityBatchStartIndex: number;         // First entry index in current batch
  lastActivityPostTime: number;            // For rate limiting thread posts
  threadParentTs: string | null;           // Status message ts (thread parent for activity entries)
  // Track posted batch for updates when tool_result arrives (race condition fix)
  postedBatchTs: string | null;            // Ts of most recently posted batch
  postedBatchToolUseIds: Set<string>;      // tool_use_ids in the posted batch
}

/**
 * Flush pending activity batch to thread.
 *
 * Called on timer, before long content (thinking/response), or on completion.
 * Batches tool entries together, posts them as a single thread reply.
 *
 * @param state - Activity batch state (will be mutated)
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param charLimit - Character limit for truncation
 * @param reason - Why we're flushing ('timer' | 'long_content' | 'complete')
 * @param userId - User ID for file uploads
 */
export async function flushActivityBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  charLimit: number,
  reason: 'timer' | 'long_content' | 'complete',
  userId?: string
): Promise<void> {
  // Nothing to flush
  if (state.activityBatch.length === 0) {
    return;
  }

  // Need a parent to post to
  if (!state.threadParentTs) {
    console.warn('[activity-thread] No thread parent ts, cannot flush batch');
    return;
  }

  // Format the batch
  const content = formatThreadActivityBatch(state.activityBatch);
  if (!content) {
    // Clear batch even if empty content
    state.activityBatch = [];
    return;
  }

  try {
    // Post to thread
    const result = await postActivityToThread(
      client,
      channelId,
      state.threadParentTs,
      content,
      { charLimit, userId }
    );

    if (result?.ts) {
      // Store for potential updates when tool_result arrives
      state.postedBatchTs = result.ts;
      state.postedBatchToolUseIds = new Set(
        state.activityBatch
          .filter(e => e.type === 'tool_complete' && e.toolUseId)
          .map(e => e.toolUseId!)
      );
      // Update last post time for rate limiting
      state.lastActivityPostTime = Date.now();

      // Capture permalink and store on all batch entries for clickable activity links
      try {
        const permalink = await getMessagePermalink(client, channelId, result.ts);
        for (const entry of state.activityBatch) {
          entry.threadMessageTs = result.ts;
          entry.threadMessageLink = permalink;
        }
      } catch (permalinkError) {
        console.error('[activity-thread] Failed to get permalink for batch:', permalinkError);
      }
    }
  } catch (error) {
    console.error('[activity-thread] Failed to flush batch:', error);
  }

  // Clear batch after posting (success or failure)
  state.activityBatch = [];
}

/**
 * Update the most recently posted batch message with new metrics.
 * Called when tool_result arrives after batch was already flushed.
 *
 * @param state - Activity batch state
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param activityLog - Full activity log (to re-render entries)
 * @param toolUseId - tool_use_id that just received results
 */
export async function updatePostedBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  activityLog: ActivityEntry[],
  toolUseId: string
): Promise<void> {
  // Only update if this tool was in the posted batch
  if (!state.postedBatchTs || !state.postedBatchToolUseIds?.has(toolUseId)) {
    return;
  }

  // Re-render entries that were in the posted batch
  const batchEntries = activityLog.filter(
    e => e.type === 'tool_complete' && e.toolUseId && state.postedBatchToolUseIds.has(e.toolUseId)
  );

  const content = formatThreadActivityBatch(batchEntries);
  if (!content) return;

  try {
    await client.chat.update({
      channel: channelId,
      ts: state.postedBatchTs,
      text: content,
    });
    console.log(`[activity-thread] Updated posted batch with tool result metrics for ${toolUseId}`);
  } catch (error) {
    // Message may have been deleted or too old - ignore
    console.warn('[activity-thread] Failed to update posted batch:', error);
  }
}

/**
 * Post a thinking message to thread.
 *
 * Thinking gets its own message (not batched with tools).
 * If content exceeds limit, attaches .md file.
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param parentTs - Thread parent timestamp
 * @param entry - Thinking activity entry
 * @param charLimit - Character limit for truncation
 * @param userId - User ID for file uploads
 * @returns Posted message ts or null
 */
export async function postThinkingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry: ActivityEntry,
  charLimit: number,
  userId?: string
): Promise<string | null> {
  const content = entry.thinkingContent || entry.thinkingTruncated || '';
  const truncated = content.length > charLimit;
  const formattedText = formatThreadThinkingMessage(entry, truncated, charLimit);

  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formattedText,
    {
      fullMarkdown: truncated ? content : undefined,
      charLimit,
      userId,
    }
  );

  const ts = result?.ts ?? null;

  // Capture permalink and store on entry for clickable activity links
  if (ts) {
    try {
      entry.threadMessageTs = ts;
      entry.threadMessageLink = await getMessagePermalink(client, channelId, ts);
    } catch (error) {
      console.error('[postThinkingToThread] Failed to get permalink:', error);
    }
  }

  return ts;
}

/**
 * Post a response message to thread.
 *
 * Response gets its own message (not batched with tools).
 * If content exceeds limit, attaches .md file.
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param parentTs - Thread parent timestamp
 * @param content - Full response content
 * @param durationMs - Response generation duration
 * @param charLimit - Character limit for truncation
 * @param userId - User ID for file uploads
 * @returns Object with posted message ts and permalink, or null
 */
export async function postResponseToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  durationMs: number | undefined,
  charLimit: number,
  userId?: string
): Promise<{ ts: string; permalink: string } | null> {
  const truncated = content.length > charLimit;
  const formattedText = formatThreadResponseMessage(
    content.length,
    durationMs,
    content,  // Pass full content, let formatter handle truncation
    truncated,
    charLimit
  );

  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formattedText,
    {
      fullMarkdown: truncated ? content : undefined,
      charLimit,
      userId,
    }
  );

  const ts = result?.ts;
  if (!ts) return null;

  // Get permalink for clickable activity links
  let permalink: string;
  try {
    permalink = await getMessagePermalink(client, channelId, ts);
  } catch (error) {
    console.error('[postResponseToThread] Failed to get permalink:', error);
    permalink = `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  }

  return { ts, permalink };
}

/**
 * Post a starting message to thread.
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param parentTs - Thread parent timestamp
 * @returns Posted message ts or null
 */
export async function postStartingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry?: ActivityEntry
): Promise<string | null> {
  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formatThreadStartingMessage()
  );

  const ts = result?.ts ?? null;

  // Capture permalink and store on entry for clickable activity links
  if (ts && entry) {
    try {
      entry.threadMessageTs = ts;
      entry.threadMessageLink = await getMessagePermalink(client, channelId, ts);
    } catch (error) {
      console.error('[postStartingToThread] Failed to get permalink:', error);
    }
  }

  return ts;
}

/**
 * Post an error message to thread.
 *
 * @param client - Slack WebClient
 * @param channelId - Channel ID
 * @param parentTs - Thread parent timestamp
 * @param message - Error message
 * @returns Posted message ts or null
 */
export async function postErrorToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  message: string
): Promise<string | null> {
  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formatThreadErrorMessage(message)
  );

  return result?.ts ?? null;
}
