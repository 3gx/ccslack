#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import fs from 'fs';

// Answer directory for file-based communication with Slack bot
const ANSWER_DIR = '/tmp/ccslack-answers';

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
              },
              required: ["question"],
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
        });
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handleAskUser(params: { question: string; options?: string[] }) {
    const { question, options } = params;

    // Get Slack context from environment
    const slackContextStr = process.env.SLACK_CONTEXT;
    if (!slackContextStr) {
      return {
        content: [{ type: "text", text: "Error: No Slack context available" }],
      };
    }

    const slackContext: SlackContext = JSON.parse(slackContextStr);
    const { channel, threadTs, user } = slackContext;

    // Generate unique question ID
    const questionId = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Build Slack blocks
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Claude needs your input:*\n${question}`,
        },
      },
    ];

    // Add buttons if options provided
    if (options && options.length > 0) {
      blocks.push({
        type: "actions",
        block_id: `question_${questionId}`,
        elements: options.map((opt, i) => ({
          type: "button",
          text: { type: "plain_text", text: opt },
          action_id: `answer_${questionId}_${i}`,
          value: opt,
        })),
      });
    } else {
      // If no options, add a text input hint
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_Reply to this message with your answer_",
          },
        ],
      });
    }

    try {
      // Post question to Slack
      const result = await this.slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks,
        text: question,
      });

      console.error(`[MCP] Posted question ${questionId} to Slack`);

      // Wait for user response (no timeout - can wait indefinitely)
      const answer = await this.waitForAnswer(questionId);

      // Update message to show answered
      if (result.ts) {
        await this.slack.chat.update({
          channel,
          ts: result.ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Claude asked:* ${question}\n\n*You answered:* ${answer}`,
              },
            },
          ],
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
