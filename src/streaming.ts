import { WebClient } from '@slack/web-api';

// Throttle interval for fallback mode (2 seconds = 30 updates/min, well under 50/min limit)
const UPDATE_INTERVAL_MS = 2000;

export interface StreamingOptions {
  channel: string;
  userId: string;
  threadTs?: string;
}

export interface StreamingSession {
  appendText: (text: string) => Promise<void>;
  finish: () => Promise<void>;
  error: (message: string) => Promise<void>;
}

/**
 * Start a streaming session to Slack.
 * Tries the native streaming API first, falls back to chat.update throttling.
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

  return {
    async appendText(text: string) {
      await (client.chat as any).appendStream({
        stream_id: streamId,
        markdown_text: text,
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
  // Post initial message
  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: '...',
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
          text: accumulatedText,
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
    async appendText(text: string) {
      accumulatedText += text;
      await throttledUpdate();
    },

    async finish() {
      // Final update with complete text
      if (accumulatedText) {
        try {
          await client.chat.update({
            channel,
            ts: messageTs,
            text: accumulatedText,
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
): Promise<{ fullResponse: string; sessionId: string | null }> {
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
        if (resultMsg.result && resultMsg.result !== fullResponse) {
          // Result differs from accumulated - update with result
          fullResponse = resultMsg.result;
        }
      }
    }

    await session.finish();
    return { fullResponse, sessionId };
  } catch (err) {
    await session.error((err as Error).message);
    throw err;
  }
}
