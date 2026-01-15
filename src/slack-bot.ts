import { App } from '@slack/bolt';
import { startClaudeQuery, ClaudeQuery } from './claude-client.js';
import { getSession, saveSession } from './session-manager.js';
import { isSessionActiveInTerminal, buildConcurrentWarningBlocks, getContinueCommand } from './concurrent-check.js';
import { streamToSlack } from './streaming.js';
import { buildStatusBlocks } from './blocks.js';
import { markAborted, isAborted, clearAborted } from './abort-tracker.js';
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

// Store pending multi-select selections (before user clicks Submit)
const pendingSelections = new Map<string, string[]>();

// Track busy conversations (processing a request)
const busyConversations = new Set<string>();

// Track active queries for abort capability
interface ActiveQuery {
  query: ClaudeQuery;
  statusMsgTs: string;
}
const activeQueries = new Map<string, ActiveQuery>();

// Helper to get unique conversation key (channel + thread)
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

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
  const conversationKey = getConversationKey(channelId, threadTs);

  // Check if conversation is busy
  if (busyConversations.has(conversationKey)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "I'm busy with the current request. Please wait for it to complete, or click Abort.",
    });
    return;
  }

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

  // Mark conversation as busy
  busyConversations.add(conversationKey);

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

  // Post status message with abort button
  let statusMsgTs: string | undefined;
  try {
    const statusResult = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildStatusBlocks({ status: 'processing', messageTs: conversationKey }),
      text: 'Processing...',
    });
    statusMsgTs = statusResult.ts;
  } catch (error) {
    console.error('Error posting status message:', error);
  }

  // Stream Claude response to Slack with real-time updates
  try {
    // Start Claude query (returns Query object with interrupt() method)
    const claudeQuery = startClaudeQuery(userText!, {
      sessionId: session.sessionId ?? undefined,
      workingDir: session.workingDir,
      slackContext: {
        channel: channelId,
        threadTs,
        user: userId ?? 'unknown',
      },
    });

    // Track active query for abort capability
    if (statusMsgTs) {
      activeQueries.set(conversationKey, {
        query: claudeQuery,
        statusMsgTs,
      });
    }

    // Use streaming module for real-time Slack updates
    const { fullResponse, sessionId: newSessionId } = await streamToSlack(
      client,
      {
        channel: channelId,
        userId: userId ?? 'unknown',
        threadTs,
      },
      claudeQuery
    );

    // Delete status message when done (only if not aborted)
    if (statusMsgTs && !isAborted(conversationKey)) {
      try {
        await client.chat.delete({
          channel: channelId,
          ts: statusMsgTs,
        });
      } catch (error) {
        console.error('Error deleting status message:', error);
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

    // Save session
    if (newSessionId) {
      saveSession(channelId, { sessionId: newSessionId });
    }

  } catch (error: any) {
    console.error('Error streaming Claude response:', error);

    // Update status to error (only if not aborted)
    if (statusMsgTs && !isAborted(conversationKey)) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: statusMsgTs,
          blocks: buildStatusBlocks({ status: 'error', errorMessage: error.message }),
          text: `Error: ${error.message}`,
        });
      } catch (e) {
        console.error('Error updating status to error:', e);
      }
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
    // Always clean up busy state and active queries
    busyConversations.delete(conversationKey);
    activeQueries.delete(conversationKey);
    clearAborted(conversationKey);
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

    // Update status message to "Aborted"
    const bodyWithChannel = body as any;
    if (bodyWithChannel.channel?.id) {
      try {
        await client.chat.update({
          channel: bodyWithChannel.channel.id,
          ts: active.statusMsgTs,
          blocks: buildStatusBlocks({ status: 'aborted' }),
          text: 'Aborted',
        });
      } catch (error) {
        console.error('Error updating status to aborted:', error);
      }
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
