import { WebClient } from '@slack/web-api';
import { markdownToSlack } from './utils.js';
import { withSlackRetry } from './retry.js';
import { markdownToPng } from './markdown-png.js';

// Throttle interval for fallback mode (2 seconds = 30 updates/min, well under 50/min limit)
const UPDATE_INTERVAL_MS = 2000;

// Max message length for Slack (actual limit is 40K, but 4K is better for readability)
const SLACK_MAX_LENGTH = 4000;

export interface StreamingOptions {
  channel: string;
  userId: string;
  threadTs?: string;
}

export interface StreamingSession {
  appendText: (text: string) => Promise<void>;
  finish: () => Promise<void>;
  error: (message: string) => Promise<void>;
  messageTs: string | null; // Timestamp of the streaming message (for cleanup)
}

/**
 * Start a streaming session to Slack.
 * Tries the native streaming API first, falls back to chat.update throttling.
 * Exported for use in slack-bot.ts to get messageTs before streaming starts.
 */
export async function startStreamingSession(
  client: WebClient,
  options: StreamingOptions
): Promise<StreamingSession> {
  const { channel, userId, threadTs } = options;

  // Try native streaming API first
  try {
    return await startNativeStreaming(client, channel, userId);
  } catch (err) {
    console.log('Native streaming unavailable, using fallback:', (err as Error).message);
    return await startFallbackStreaming(client, channel, threadTs);
  }
}

/**
 * Native Slack streaming API (Oct 2025)
 * Uses chat.startStream, chat.appendStream, chat.stopStream
 */
async function startNativeStreaming(
  client: WebClient,
  channel: string,
  userId: string
): Promise<StreamingSession> {
  // Start the stream
  const stream = await (client.chat as any).startStream({
    channel,
    recipient_user_id: userId,
  });

  const streamId = stream.stream_id;
  console.log(`Started native stream: ${streamId}`);

  // Track accumulated text for conversion
  let accumulatedText = '';

  return {
    messageTs: null, // Native streaming doesn't use a regular message

    async appendText(text: string) {
      accumulatedText += text;
      await (client.chat as any).appendStream({
        stream_id: streamId,
        markdown_text: markdownToSlack(accumulatedText),
      });
    },

    async finish() {
      await (client.chat as any).stopStream({
        stream_id: streamId,
      });
      console.log(`Finished native stream: ${streamId}`);
    },

    async error(message: string) {
      await (client.chat as any).stopStream({
        stream_id: streamId,
        error_message: message,
      });
      console.log(`Error in native stream: ${streamId} - ${message}`);
    },
  };
}

/**
 * Fallback streaming using chat.postMessage + chat.update with throttling
 * Updates every 2 seconds to stay under rate limits
 */
async function startFallbackStreaming(
  client: WebClient,
  channel: string,
  threadTs?: string
): Promise<StreamingSession> {
  // Post initial message (use invisible placeholder - will be replaced with content)
  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: '\u200B', // Zero-width space - invisible placeholder
  });

  const messageTs = result.ts!;
  let accumulatedText = '';
  let lastUpdateTime = 0;
  let updatePending = false;

  console.log(`Started fallback stream: ${messageTs}`);

  // Throttled update function
  async function throttledUpdate() {
    const now = Date.now();
    if (now - lastUpdateTime >= UPDATE_INTERVAL_MS && accumulatedText) {
      updatePending = false;
      lastUpdateTime = now;
      try {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: markdownToSlack(accumulatedText),
        });
      } catch (err) {
        console.error('Error updating message:', err);
      }
    } else if (accumulatedText && !updatePending) {
      // Schedule an update for later
      updatePending = true;
      const delay = UPDATE_INTERVAL_MS - (now - lastUpdateTime);
      setTimeout(() => throttledUpdate(), delay);
    }
  }

  return {
    messageTs, // Expose for cleanup on abort

    async appendText(text: string) {
      accumulatedText += text;
      await throttledUpdate();
    },

    async finish() {
      // Final update with complete text (converted to Slack format)
      if (accumulatedText) {
        try {
          await client.chat.update({
            channel,
            ts: messageTs,
            text: markdownToSlack(accumulatedText),
          });
        } catch (err) {
          console.error('Error in final update:', err);
        }
      }
      console.log(`Finished fallback stream: ${messageTs}`);
    },

    async error(message: string) {
      try {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: `Error: ${message}`,
        });
      } catch (err) {
        console.error('Error updating error message:', err);
      }
      console.log(`Error in fallback stream: ${messageTs} - ${message}`);
    },
  };
}

/**
 * Helper to stream Claude response to Slack
 * Handles the full flow: start stream, append chunks, finish/error
 */
export async function streamToSlack(
  client: WebClient,
  options: StreamingOptions,
  asyncIterator: AsyncIterable<{ type: string; content?: string | any[] }>
): Promise<{ fullResponse: string; sessionId: string | null; streamingMsgTs: string | null }> {
  const session = await startStreamingSession(client, options);

  let fullResponse = '';
  let sessionId: string | null = null;

  try {
    for await (const msg of asyncIterator) {
      // Capture session ID from init message
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        console.log(`Session initialized: ${sessionId}`);
      }

      // Handle assistant content
      if (msg.type === 'assistant' && 'content' in msg) {
        const content = msg.content;
        if (typeof content === 'string') {
          fullResponse += content;
          await session.appendText(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              fullResponse += block.text;
              await session.appendText(block.text);
            }
          }
        }
      }

      // Handle result messages (final response)
      if (msg.type === 'result') {
        const resultMsg = msg as any;
        if (resultMsg.result) {
          // If result differs from what we accumulated, use result instead
          if (resultMsg.result !== fullResponse) {
            fullResponse = resultMsg.result;
            // Push the full result to Slack
            await session.appendText(fullResponse);
          }
        }
      }
    }

    await session.finish();
    return { fullResponse, sessionId, streamingMsgTs: session.messageTs };
  } catch (err) {
    await session.error((err as Error).message);
    throw err;
  }
}

// ============================================================================
// Message Splitting for Long Responses
// ============================================================================

/**
 * Split a long message into chunks that fit within Slack's limits.
 * Tries to split at natural boundaries (newlines, then spaces).
 */
export function splitMessage(text: string, maxLength: number = SLACK_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = maxLength;

    // Look for newline within last 500 chars of the limit
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > maxLength - 500 && lastNewline > 0) {
      splitAt = lastNewline + 1;
    } else {
      // Look for space within last 200 chars
      const lastSpace = remaining.lastIndexOf(' ', maxLength);
      if (lastSpace > maxLength - 200 && lastSpace > 0) {
        splitAt = lastSpace + 1;
      }
      // Otherwise just split at maxLength (may cut mid-word)
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return parts;
}

/**
 * Posted message info returned by postSplitResponse.
 */
export interface PostedMessage {
  ts: string;
}

/**
 * Post a potentially long response, splitting into multiple messages if needed.
 * Each part is posted with retry logic.
 *
 * @returns Array of posted message timestamps (for message mapping)
 */
export async function postSplitResponse(
  client: WebClient,
  channelId: string,
  text: string,
  threadTs?: string
): Promise<PostedMessage[]> {
  const parts = splitMessage(text);
  const postedMessages: PostedMessage[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;

    // Add continuation indicator if split
    const messageText = parts.length > 1 && !isLast
      ? `${part}\n\n_... continued ..._`
      : part;

    const result = await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: messageText,
      })
    );

    // Capture the timestamp of the posted message
    if (result && typeof result === 'object' && 'ts' in result) {
      postedMessages.push({ ts: result.ts as string });
    }

    // Small delay between parts to maintain order
    if (!isLast) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return postedMessages;
}

// ============================================================================
// Markdown File Attachment
// ============================================================================

/**
 * Upload markdown content as a .md file with response text as initial_comment.
 * This makes the file and response appear as a single message.
 * Returns the message timestamp on success (if available), null on failure.
 */
export async function uploadMarkdownWithResponse(
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string  // For ephemeral failure notification
): Promise<{ ts?: string } | null> {
  try {
    const result = await withSlackRetry(() =>
      client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        content: markdown,
        filename: `response-${Date.now()}.md`,
        filetype: 'markdown',
        mimetype: 'text/markdown',
        title: 'Full Response (Markdown)',
        initial_comment: slackFormattedResponse,
      } as any)
    );
    // Check if upload succeeded
    const file = (result as any).files?.[0];
    if (!file) {
      return null;  // Upload failed
    }
    // Try to get message timestamp (may not always be available)
    const ts = file?.shares?.public?.[channelId]?.[0]?.ts ||
               file?.shares?.private?.[channelId]?.[0]?.ts;
    return { ts };  // Success - ts may be undefined but upload worked
  } catch (error) {
    console.error('Failed to upload markdown file:', error);
    // Notify user of failure via ephemeral message
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '⚠️ Failed to attach .md file. The response will be posted without the attachment.',
        });
      } catch {
        // Ignore ephemeral failure
      }
    }
    return null;
  }
}

/**
 * Upload markdown content as both .md and .png files with response text as initial_comment.
 * The PNG provides a nicely rendered preview of the markdown.
 * Falls back gracefully if PNG generation fails.
 * Returns the message timestamp on success (if available), null on failure.
 */
export async function uploadMarkdownAndPngWithResponse(
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string  // For ephemeral failure notification
): Promise<{ ts?: string } | null> {
  try {
    // Generate PNG from markdown (may return null on failure)
    const pngBuffer = await markdownToPng(markdown);

    // Prepare files array - always include markdown
    const timestamp = Date.now();
    const files: Array<{ content: string | Buffer; filename: string; filetype: string; title: string }> = [
      {
        content: markdown,
        filename: `response-${timestamp}.md`,
        filetype: 'markdown',
        title: 'Full Response (Markdown)',
      },
    ];

    // Add PNG if generation succeeded
    if (pngBuffer) {
      files.push({
        content: pngBuffer,
        filename: `response-${timestamp}.png`,
        filetype: 'png',
        title: 'Response Preview',
      });
    }

    // Upload files with initial_comment
    // Note: file_uploads requires Buffer for content, not raw strings
    const result = await withSlackRetry(() =>
      client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file_uploads: files.map((f) => ({
          file: typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
          filename: f.filename,
          title: f.title,
        })),
        initial_comment: slackFormattedResponse,
      } as any)
    );

    // Check if upload succeeded
    const uploadedFiles = (result as any).files;
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return null;  // Upload failed
    }

    // Try to get message timestamp from first file
    const file = uploadedFiles[0];
    const ts = file?.shares?.public?.[channelId]?.[0]?.ts ||
               file?.shares?.private?.[channelId]?.[0]?.ts;
    return { ts };  // Success - ts may be undefined but upload worked
  } catch (error) {
    console.error('Failed to upload markdown/png files:', error);
    // Notify user of failure via ephemeral message
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '⚠️ Failed to attach files. The response will be posted without attachments.',
        });
      } catch {
        // Ignore ephemeral failure
      }
    }
    return null;
  }
}
