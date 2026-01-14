import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StreamOptions {
  sessionId?: string;
  workingDir?: string;
  slackContext?: {
    channel: string;
    threadTs?: string;
    user: string;
  };
}

export async function* streamClaude(
  prompt: string,
  options: StreamOptions
): AsyncGenerator<SDKMessage, void, unknown> {

  const queryOptions: Record<string, unknown> = {
    outputFormat: 'stream-json',
    permissionMode: 'bypassPermissions', // For now, auto-approve all
    // Claude Code preset configuration
    systemPrompt: 'claude_code',
  };

  if (options.workingDir) {
    queryOptions.cwd = options.workingDir;
  }

  if (options.sessionId) {
    queryOptions.resume = options.sessionId;
    console.log(`Resuming session: ${options.sessionId}`);
  } else {
    console.log('Starting new Claude conversation');
  }

  // Add MCP server for ask_user tool if we have Slack context
  if (options.slackContext) {
    const mcpServerPath = path.join(__dirname, 'mcp-server.ts');
    queryOptions.mcpServers = {
      'ask-user': {
        command: 'npx',
        args: ['tsx', mcpServerPath],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
          SLACK_CONTEXT: JSON.stringify(options.slackContext),
        },
      },
    };
    // Allow the MCP tools
    queryOptions.allowedTools = ['mcp__ask-user__ask_user', 'mcp__ask-user__approve_action'];
    console.log('MCP ask-user server configured');
  }

  for await (const message of query({
    prompt,
    options: queryOptions,
  })) {
    yield message;
  }
}
