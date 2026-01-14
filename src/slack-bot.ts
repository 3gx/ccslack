import { App } from '@slack/bolt';
import { streamClaude } from './claude-client.js';
import { getSession, saveSession } from './session-manager.js';

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
    threadTs: event.thread_ts || event.ts,
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

  console.log(`Received DM from ${userId}: ${userText}`);

  await handleMessage({
    channelId,
    userId,
    userText,
    client,
  });
});

// Common message handler
async function handleMessage(params: {
  channelId: string;
  userId: string;
  userText: string;
  threadTs?: string;
  client: any;
}) {
  const { channelId, userId, userText, threadTs, client } = params;

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

  // Post initial "thinking" message (in thread if applicable)
  const result = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: '...',
  });
  const messageTs = result.ts!;

  // Stream Claude response
  let fullResponse = '';
  let newSessionId: string | null = null;
  let lastUpdate = 0;

  try {
    for await (const msg of streamClaude(userText!, {
      sessionId: session.sessionId ?? undefined,
      workingDir: session.workingDir,
      slackContext: {
        channel: channelId,
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

        // Update message every 2 seconds (rate limit safe)
        if (Date.now() - lastUpdate >= 2000) {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: fullResponse || '...',
          });
          lastUpdate = Date.now();
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

    // Final update
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: fullResponse || 'Done.',
    });

    // Save session
    if (newSessionId) {
      saveSession(channelId, { sessionId: newSessionId });
    }

  } catch (error: any) {
    console.error('Error streaming Claude response:', error);
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Error: ${error.message}`,
    });
  }
}

// Handle button clicks for ask_user tool
app.action(/^answer_(.+)_(\d+)$/, async ({ action, ack, body, client }) => {
  await ack();

  // Extract question ID from action_id: "answer_{questionId}_{index}"
  const actionId = 'action_id' in action ? action.action_id : '';
  const parts = actionId.split('_');
  const questionId = parts[1];
  const answer = 'value' in action ? action.value : '';

  console.log(`Button clicked: questionId=${questionId}, answer=${answer}`);

  // Note: The MCP server runs as a subprocess and handles its own state.
  // Button clicks will be handled by the MCP server's Slack client directly.
  // For Phase 1, we just acknowledge the click.

  // Update message to show selection (the MCP server will also update it)
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
