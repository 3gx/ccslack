import { App } from '@slack/bolt';
import { streamClaude } from './claude-client.js';
import { getSession, saveSession } from './session-manager.js';
import { isSessionActiveInTerminal, buildConcurrentWarningBlocks, getContinueCommand } from './concurrent-check.js';
import { streamToSlack } from './streaming.js';
import fs from 'fs';

// Answer directory for file-based communication with MCP subprocess
const ANSWER_DIR = '/tmp/ccslack-answers';

// Store pending messages when concurrent session detected
interface PendingMessage {
  channelId: string;
  userId: string | undefined;
  userText: string;
  originalTs?: string;
  threadTs?: string;
}
const pendingMessages = new Map<string, PendingMessage>();

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
  userId: string | undefined;
  userText: string;
  originalTs?: string;
  threadTs?: string;
  client: any;
  skipConcurrentCheck?: boolean;
}) {
  const { channelId, userId, userText, originalTs, threadTs, client, skipConcurrentCheck } = params;

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

  // Check for concurrent terminal session
  if (session.sessionId && !skipConcurrentCheck) {
    const concurrentCheck = await isSessionActiveInTerminal(session.sessionId);
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

  // Stream Claude response to Slack with real-time updates
  try {
    const claudeStream = streamClaude(userText!, {
      sessionId: session.sessionId ?? undefined,
      workingDir: session.workingDir,
      slackContext: {
        channel: channelId,
        threadTs,
        user: userId ?? 'unknown',
      },
    });

    // Use streaming module for real-time Slack updates
    const { fullResponse, sessionId: newSessionId } = await streamToSlack(
      client,
      {
        channel: channelId,
        userId: userId ?? 'unknown',
        threadTs,
      },
      claudeStream
    );

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

export async function startBot() {
  await app.start();
  console.log('Bot is running!');
}
