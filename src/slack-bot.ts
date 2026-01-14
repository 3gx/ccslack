import { App } from '@slack/bolt';
import { streamClaude } from './claude-client.js';
import { getSession, saveSession } from './session-manager.js';
import fs from 'fs';

// Answer directory for file-based communication with MCP subprocess
const ANSWER_DIR = '/tmp/ccslack-answers';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Handle @mentions in channels
app.event('app_mention', async ({ event, client }) => {
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
});

// Handle DM messages
app.message(async ({ message, client }) => {
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
});

// Common message handler
async function handleMessage(params: {
  channelId: string;
  userId: string;
  userText: string;
  originalTs?: string;
  threadTs?: string;
  client: any;
}) {
  const { channelId, userId, userText, originalTs, threadTs, client } = params;

  // Get or create session
  let session = getSession(channelId);
  if (!session) {
    session = {
      sessionId: null,
      workingDir: process.cwd(),
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    saveSession(channelId, session);
  }

  // Add eyes reaction to show we're processing
  if (originalTs) {
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch (error) {
      console.error('Error adding reaction:', error);
    }
  }

  // Stream Claude response
  let fullResponse = '';
  let newSessionId: string | null = null;

  try {
    for await (const msg of streamClaude(userText!, {
      sessionId: session.sessionId ?? undefined,
      workingDir: session.workingDir,
      slackContext: {
        channel: channelId,
        threadTs,
        user: userId,
      },
    })) {
      // Capture session ID from init message
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = (msg as any).session_id;
        console.log(`Session initialized: ${newSessionId}`);
      }

      // Accumulate assistant content
      if (msg.type === 'assistant' && 'content' in msg) {
        const content = (msg as any).content;
        if (typeof content === 'string') {
          fullResponse += content;
        } else if (Array.isArray(content)) {
          // Handle content blocks
          for (const block of content) {
            if (block.type === 'text') {
              fullResponse += block.text;
            }
          }
        }
      }

      // Handle result messages (final response)
      if (msg.type === 'result') {
        const resultMsg = msg as any;
        if (resultMsg.result) {
          fullResponse = resultMsg.result;
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

    // Post response (in thread only if already in a thread)
    if (fullResponse) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs, // undefined for channel messages, set for thread replies
        text: fullResponse,
      });
    }

    // Save session
    if (newSessionId) {
      saveSession(channelId, { sessionId: newSessionId });
    }

  } catch (error: any) {
    console.error('Error streaming Claude response:', error);

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

export async function startBot() {
  await app.start();
  console.log('Bot is running!');
}
