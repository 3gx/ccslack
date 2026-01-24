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

/**
 * Default character limit for thread messages before truncation + attachment.
 */
const DEFAULT_THREAD_CHAR_LIMIT = 500;

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
      // Update last post time for rate limiting
      state.lastActivityPostTime = Date.now();
    }
  } catch (error) {
    console.error('[activity-thread] Failed to flush batch:', error);
  }

  // Clear batch after posting (success or failure)
  state.activityBatch = [];
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

  return result?.ts ?? null;
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
 * @returns Posted message ts or null
 */
export async function postResponseToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  durationMs: number | undefined,
  charLimit: number,
  userId?: string
): Promise<string | null> {
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

  return result?.ts ?? null;
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
  parentTs: string
): Promise<string | null> {
  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formatThreadStartingMessage()
  );

  return result?.ts ?? null;
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
