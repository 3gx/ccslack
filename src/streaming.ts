import { WebClient } from '@slack/web-api';
import { markdownToSlack, stripMarkdownCodeFence } from './utils.js';
import { withSlackRetry } from './retry.js';
import { markdownToPng } from './markdown-png.js';
import { saveMessageMapping } from './session-manager.js';

// Throttle interval for fallback mode (2 seconds = 30 updates/min, well under 50/min limit)
const UPDATE_INTERVAL_MS = 2000;

// Default char limit for truncation (when to truncate long responses)
const THREAD_CHAR_DEFAULT = 500;

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
// Text Truncation with Closed Formatting
// ============================================================================

/**
 * Truncate text and close any open formatting markers.
 * Handles: ``` code blocks, ` inline code, * bold, _ italic, ~ strikethrough
 */
export function truncateWithClosedFormatting(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Reserve space for suffix and potential closing markers
  const suffix = '\n\n_...truncated. Full response attached._';
  const maxContent = limit - suffix.length - 10; // 10 chars buffer for closing markers

  let truncated = text.substring(0, maxContent);

  // Find good break point (newline or space)
  const lastNewline = truncated.lastIndexOf('\n');
  const lastSpace = truncated.lastIndexOf(' ');
  const minBreak = Math.floor(maxContent * 0.8);
  const breakPoint = Math.max(
    lastNewline > minBreak ? lastNewline : -1,
    lastSpace > minBreak ? lastSpace : -1,
    minBreak
  );
  truncated = truncated.substring(0, breakPoint);

  // Close open code blocks (```)
  const codeBlockCount = (truncated.match(/```/g) || []).length;
  const insideCodeBlock = codeBlockCount % 2 === 1;
  if (insideCodeBlock) {
    truncated += '\n```';
  }

  // Only check inline formatting if NOT inside a code block
  // (inside code blocks, backticks/asterisks/etc are literal characters)
  if (!insideCodeBlock) {
    // Close open inline code (`) - count single backticks not part of ```
    const inlineCodeCount = (truncated.match(/(?<!`)`(?!`)/g) || []).length;
    if (inlineCodeCount % 2 === 1) {
      truncated += '`';
    }

    // Close open bold (*) - count single asterisks not part of ** or ***
    const boldCount = (truncated.match(/(?<!\*)\*(?!\*)/g) || []).length;
    if (boldCount % 2 === 1) {
      truncated += '*';
    }

    // Close open italic (_)
    const italicCount = (truncated.match(/(?<!_)_(?!_)/g) || []).length;
    if (italicCount % 2 === 1) {
      truncated += '_';
    }

    // Close open strikethrough (~)
    const strikeCount = (truncated.match(/~/g) || []).length;
    if (strikeCount % 2 === 1) {
      truncated += '~';
    }
  }

  return truncated + suffix;
}

// ============================================================================
// Markdown File Attachment
// ============================================================================

/**
 * Upload markdown content as a .md file with properly formatted response text.
 *
 * Simplified behavior:
 * - Short response (< limit): post full text, then upload file
 * - Long response (> limit): post truncated text with closed formatting, then upload file
 *
 * No threading. No splitting. Just truncate and attach.
 *
 * Returns timestamps for message mapping, or null on complete failure.
 */
export async function uploadMarkdownWithResponse(
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string,
  threadCharLimit?: number,
  stripEmptyTag?: boolean
): Promise<{ ts?: string; postedMessages?: { ts: string }[] } | null> {
  const limit = threadCharLimit ?? THREAD_CHAR_DEFAULT;

  // Strip markdown code fence wrapper if present (e.g., ```markdown ... ```)
  const cleanMarkdown = stripMarkdownCodeFence(markdown, { stripEmptyTag });

  try {
    // Step 1: Post formatted text (truncated if needed)
    const textToPost = slackFormattedResponse.length <= limit
      ? slackFormattedResponse
      : truncateWithClosedFormatting(slackFormattedResponse, limit);

    const textResult = await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: textToPost,
      })
    );

    const textTs = (textResult as any).ts;
    const postedMessages: { ts: string }[] = textTs ? [{ ts: textTs }] : [];

    // Step 2: Upload file (will appear after text message)
    await withSlackRetry(() =>
      client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        content: cleanMarkdown,
        filename: `response-${Date.now()}.md`,
        title: 'Full Response (Markdown)',
      } as any)
    );

    return {
      ts: textTs,
      postedMessages,
    };
  } catch (error) {
    console.error('Failed to upload markdown file:', error);
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to attach .md file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      } catch {
        // Ignore ephemeral failure
      }
    }
    return null;
  }
}

/**
 * Upload markdown content as both .md and .png files with properly formatted response text.
 * The PNG provides a nicely rendered preview of the markdown.
 * Falls back gracefully if PNG generation fails.
 *
 * Simplified behavior:
 * - Short response (< limit): post full text, then upload files
 * - Long response (> limit): post truncated text with closed formatting, then upload files
 *
 * No threading. No splitting. Just truncate and attach.
 *
 * Returns timestamps for message mapping, or null on complete failure.
 */
/**
 * Mapping info for immediate message mapping save after posting.
 * This enables point-in-time forking by saving the mapping atomically with the post.
 */
export interface MappingInfo {
  sdkMessageId: string;
  sessionId: string;
}

export async function uploadMarkdownAndPngWithResponse(
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string,
  threadCharLimit?: number,
  stripEmptyTag?: boolean,
  mappingInfo?: MappingInfo
): Promise<{ ts?: string; postedMessages?: { ts: string }[]; uploadSucceeded?: boolean } | null> {
  const limit = threadCharLimit ?? THREAD_CHAR_DEFAULT;

  // Strip markdown code fence wrapper if present (e.g., ```markdown ... ```)
  const cleanMarkdown = stripMarkdownCodeFence(markdown, { stripEmptyTag });

  try {
    // Step 1: Prepare text (truncated if needed)
    const textToPost = slackFormattedResponse.length <= limit
      ? slackFormattedResponse
      : truncateWithClosedFormatting(slackFormattedResponse, limit);

    // Track if response was truncated (for conditional file attachment)
    const wasTruncated = slackFormattedResponse.length > limit;

    let textTs: string | undefined;
    const postedMessages: { ts: string }[] = [];

    // Step 2: Post message - with files if truncated, just text otherwise
    if (wasTruncated) {
      // Generate PNG from markdown (may return null on failure)
      const pngBuffer = await markdownToPng(cleanMarkdown);

      // Prepare files array - always include markdown
      const timestamp = Date.now();
      const files: Array<{ content: string | Buffer; filename: string; title: string }> = [
        {
          content: cleanMarkdown,
          filename: `response-${timestamp}.md`,
          title: 'Full Response (Markdown)',
        },
      ];

      // Add PNG if generation succeeded
      if (pngBuffer) {
        files.push({
          content: pngBuffer,
          filename: `response-${timestamp}.png`,
          title: 'Response Preview',
        });
      }

      // Upload files WITH the response text as initial_comment
      // This posts files and text together in the same message
      const fileResult = await withSlackRetry(() =>
        client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          initial_comment: textToPost,
          file_uploads: files.map((f) => ({
            file: typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
            filename: f.filename,
            title: f.title,
          })),
        } as any)
      );

      // Get ts from the file message for mapping
      // files.uploadV2 returns files array with shares info
      // Check both public and private shares (private channels use shares.private)
      const shares = (fileResult as any)?.files?.[0]?.shares;
      textTs = shares?.public?.[channelId]?.[0]?.ts ?? shares?.private?.[channelId]?.[0]?.ts;
      if (textTs) {
        postedMessages.push({ ts: textTs });
      } else {
        // files.uploadV2 succeeded but textTs extraction failed
        // Log for debugging and mark upload as succeeded to prevent duplicate fallback
        console.error('[uploadMarkdownAndPng] textTs extraction failed after successful upload');
        console.error('[uploadMarkdownAndPng] channelId:', channelId);
        console.error('[uploadMarkdownAndPng] fileResult:', JSON.stringify(fileResult, null, 2));
      }
    } else {
      // Short response - just post text (no files)
      const textResult = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: textToPost,
        })
      );

      textTs = (textResult as any).ts;
      if (textTs) {
        postedMessages.push({ ts: textTs });
      }
    }

    // CRITICAL: Save message mapping IMMEDIATELY after posting for point-in-time forking
    // This ensures the mapping is saved atomically with the post, not in a batch at the end
    // Pattern follows terminal-watcher.ts for crash-resilience
    if (textTs && mappingInfo) {
      saveMessageMapping(channelId, textTs, {
        sdkMessageId: mappingInfo.sdkMessageId,
        sessionId: mappingInfo.sessionId,
        type: 'assistant',
      });
      console.log(`[Mapping] Saved assistant mapping immediately: ${textTs} → ${mappingInfo.sdkMessageId}`);
    }

    return {
      ts: textTs,
      postedMessages,
      uploadSucceeded: wasTruncated && !textTs,  // True when upload worked but ts extraction failed
    };
  } catch (error) {
    console.error('Failed to upload markdown/png files:', error);
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to attach files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      } catch {
        // Ignore ephemeral failure
      }
    }
    return null;
  }
}
