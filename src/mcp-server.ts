#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import fs from 'fs';
import {
  buildQuestionBlocks,
  buildApprovalBlocks,
  buildAnsweredBlocks,
  buildApprovalResultBlocks,
  buildReminderBlocks,
} from './blocks.js';
import { formatTimeRemaining } from './utils.js';

// Answer directory for file-based communication with Slack bot
const ANSWER_DIR = '/tmp/ccslack-answers';

// Reminder configuration (in-memory only, lost on restart)
const REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_REMINDERS = Math.floor(EXPIRY_MS / REMINDER_INTERVAL_MS); // 42 reminders over 7 days

// Track active reminders (in-memory)
const reminderIntervals = new Map<string, NodeJS.Timeout>();
const reminderCounts = new Map<string, number>();
const reminderStartTimes = new Map<string, number>(); // Track when reminder started for expiry calc

interface SlackContext {
  channel: string;
  threadTs?: string;
  user: string;
}

class AskUserMCPServer {
  private server: Server;
  private slack: WebClient;

  constructor() {
    this.server = new Server(
      {
        name: "ask-user",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "ask_user",
            description: "Ask the user a question via Slack and wait for their response. Use this when you need user input or clarification.",
            inputSchema: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "The question to ask the user",
                },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional list of choices for the user to select from",
                },
                multiSelect: {
                  type: "boolean",
                  description: "Allow multiple options to be selected (default: false). Auto-enabled for >5 options.",
                },
                codeContext: {
                  type: "string",
                  description: "Optional code snippet to display with the question",
                },
              },
              required: ["question"],
            },
          },
          {
            name: "approve_action",
            description: "Request user approval for an action via Slack. Use this when you need permission to proceed with something.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  description: "Description of the action that needs approval",
                },
                details: {
                  type: "string",
                  description: "Additional details about what will happen if approved",
                },
              },
              required: ["action"],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "ask_user") {
        return await this.handleAskUser(request.params.arguments as {
          question: string;
          options?: string[];
          multiSelect?: boolean;
          codeContext?: string;
        });
      }
      if (request.params.name === "approve_action") {
        return await this.handleApproveAction(request.params.arguments as {
          action: string;
          details?: string;
        });
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handleAskUser(params: {
    question: string;
    options?: string[];
    multiSelect?: boolean;
    codeContext?: string;
  }) {
    const { question, options, multiSelect, codeContext } = params;

    // Get Slack context from environment
    const slackContextStr = process.env.SLACK_CONTEXT;
    if (!slackContextStr) {
      return {
        content: [{ type: "text", text: "Error: No Slack context available" }],
      };
    }

    const slackContext: SlackContext = JSON.parse(slackContextStr);
    const { channel, threadTs } = slackContext;

    // Generate unique question ID
    const questionId = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Build Slack blocks using centralized builder
    const blocks = buildQuestionBlocks({
      question,
      options,
      questionId,
      multiSelect,
      codeContext,
    });

    try {
      // Post question to Slack
      const result = await this.slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks,
        text: question,
      });

      console.error(`[MCP] Posted question ${questionId} to Slack`);

      // Start reminder for unanswered question (in-memory only)
      this.startReminder(questionId, question, channel, threadTs);

      // Wait for user response (no timeout - can wait indefinitely)
      const answer = await this.waitForAnswer(questionId);

      // Update message to show answered
      if (result.ts) {
        await this.slack.chat.update({
          channel,
          ts: result.ts,
          blocks: buildAnsweredBlocks(question, answer),
          text: `Answered: ${answer}`,
        });
      }

      return {
        content: [{ type: "text", text: answer }],
      };
    } catch (error: any) {
      console.error(`[MCP] Error asking user:`, error);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
      };
    }
  }

  private async handleApproveAction(params: { action: string; details?: string }) {
    const { action, details } = params;

    // Get Slack context from environment
    const slackContextStr = process.env.SLACK_CONTEXT;
    if (!slackContextStr) {
      return {
        content: [{ type: "text", text: "Error: No Slack context available" }],
      };
    }

    const slackContext: SlackContext = JSON.parse(slackContextStr);
    const { channel, threadTs } = slackContext;

    // Generate unique approval ID
    const approvalId = `a_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Build Slack blocks using centralized builder
    const blocks = buildApprovalBlocks({
      action,
      details,
      questionId: approvalId,
    });

    try {
      // Post approval request to Slack
      const result = await this.slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks,
        text: `Approval needed: ${action}`,
      });

      console.error(`[MCP] Posted approval request ${approvalId} to Slack`);

      // Wait for user response
      const answer = await this.waitForAnswer(approvalId);
      const approved = answer === "approved";

      // Update message to show result
      if (result.ts) {
        await this.slack.chat.update({
          channel,
          ts: result.ts,
          blocks: buildApprovalResultBlocks(action, approved),
          text: `${approved ? "Approved" : "Denied"}: ${action}`,
        });
      }

      return {
        content: [{ type: "text", text: approved ? "approved" : "denied" }],
      };
    } catch (error: any) {
      console.error(`[MCP] Error requesting approval:`, error);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
      };
    }
  }

  private async waitForAnswer(questionId: string): Promise<string> {
    const answerFile = `${ANSWER_DIR}/${questionId}.json`;
    const pollInterval = 500; // 500ms

    console.error(`[MCP] Waiting for answer file: ${answerFile}`);

    // Poll for answer file
    while (true) {
      if (fs.existsSync(answerFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(answerFile, 'utf-8'));
          const answer = data.answer;

          // Delete file after reading
          fs.unlinkSync(answerFile);
          console.error(`[MCP] Got answer for ${questionId}: ${answer}`);

          // Clear reminder when answer received
          this.clearReminder(questionId);

          return answer;
        } catch (error) {
          console.error(`[MCP] Error reading answer file:`, error);
          // Continue polling if file read fails
        }
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Start a reminder for an unanswered question.
   * Sends reminders every 4 hours, expires after 7 days.
   * In-memory only - lost if bot restarts.
   */
  private startReminder(
    questionId: string,
    question: string,
    channel: string,
    threadTs?: string
  ) {
    const startTime = Date.now();
    reminderStartTimes.set(questionId, startTime);

    const interval = setInterval(async () => {
      const count = reminderCounts.get(questionId) || 0;

      if (count >= MAX_REMINDERS) {
        // Auto-expire after max reminders (7 days)
        console.error(`[MCP] Max reminders reached for ${questionId}, auto-aborting`);
        this.clearReminder(questionId);

        // Write abort to trigger MCP to stop waiting
        const answerFile = `${ANSWER_DIR}/${questionId}.json`;
        try {
          fs.writeFileSync(answerFile, JSON.stringify({
            answer: '__ABORTED__',
            timestamp: Date.now(),
            reason: 'expired_after_7_days',
          }));
        } catch (error) {
          console.error(`[MCP] Error writing abort file:`, error);
        }
        return;
      }

      // Calculate elapsed time and remaining time
      const elapsedMs = Date.now() - startTime;
      const remainingMs = EXPIRY_MS - elapsedMs;
      const expiresIn = formatTimeRemaining(remainingMs);

      console.error(`[MCP] Sending reminder ${count + 1} for ${questionId} (expires in ${expiresIn})`);

      try {
        await this.slack.chat.postMessage({
          channel,
          thread_ts: threadTs,
          blocks: buildReminderBlocks({
            originalQuestion: question,
            questionId,
            expiresIn,
          }),
          text: `Reminder: Still waiting for your answer to "${question}" (expires in ${expiresIn})`,
        });
      } catch (error) {
        console.error(`[MCP] Error sending reminder:`, error);
      }

      reminderCounts.set(questionId, count + 1);
    }, REMINDER_INTERVAL_MS);

    reminderIntervals.set(questionId, interval);
    console.error(`[MCP] Started reminder for ${questionId} (expires in 7 days)`);
  }

  /**
   * Clear reminder when question is answered or aborted.
   */
  private clearReminder(questionId: string) {
    const interval = reminderIntervals.get(questionId);
    if (interval) {
      clearInterval(interval);
      reminderIntervals.delete(questionId);
      reminderCounts.delete(questionId);
      reminderStartTimes.delete(questionId);
      console.error(`[MCP] Cleared reminder for ${questionId}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[MCP] ask-user server started");
  }
}

// Run if executed directly
const server = new AskUserMCPServer();
server.run().catch((error) => {
  console.error("[MCP] Server error:", error);
  process.exit(1);
});
