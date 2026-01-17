import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { PermissionMode } from './session-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Permission result from canUseTool callback (must match SDK exactly)
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }  // updatedInput is REQUIRED
  | { behavior: 'deny'; message: string; interrupt?: boolean };   // message is REQUIRED

// canUseTool callback signature from SDK
export type CanUseToolCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>;

export interface StreamOptions {
  sessionId?: string;
  workingDir?: string;
  mode?: PermissionMode;
  model?: string;  // Model ID to use (e.g., "claude-sonnet-4-5-20250929")
  forkSession?: boolean;  // Fork from sessionId instead of resuming
  resumeSessionAt?: string;  // SDK message ID for point-in-time forking
  canUseTool?: CanUseToolCallback;  // For tool approval in default mode
  slackContext?: {
    channel: string;
    threadTs?: string;
    user: string;
  };
}

// Query type with interrupt method (from SDK)
export interface ClaudeQuery extends AsyncGenerator<SDKMessage, void, unknown> {
  interrupt(): Promise<void>;
}

/**
 * Start a Claude query and return the Query object.
 * The Query object can be iterated for messages and has an interrupt() method.
 */
export function startClaudeQuery(
  prompt: string,
  options: StreamOptions
): ClaudeQuery {
  // Pass permission mode directly to SDK (we use SDK mode names)
  const permissionMode = options.mode || 'default';

  const queryOptions: Record<string, unknown> = {
    outputFormat: 'stream-json',
    permissionMode,
    // Claude Code preset configuration
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    // Enable stream_event messages for real-time activity tracking
    includePartialMessages: true,
  };

  // Add model if specified
  if (options.model) {
    queryOptions.model = options.model;
    console.log(`Using model: ${options.model}`);
  }

  if (options.workingDir) {
    queryOptions.cwd = options.workingDir;
  }

  if (options.sessionId) {
    if (options.forkSession) {
      // Fork from the parent session - creates a new session with shared history
      queryOptions.resume = options.sessionId;
      queryOptions.forkSession = true;

      // Point-in-time forking: add resumeSessionAt for forking from specific message
      if (options.resumeSessionAt) {
        queryOptions.resumeSessionAt = options.resumeSessionAt;
        console.log(`Forking from session ${options.sessionId} at message ${options.resumeSessionAt}`);
      } else {
        console.log(`Forking from session ${options.sessionId} (latest state)`);
      }
    } else {
      // Resume existing session
      queryOptions.resume = options.sessionId;
      console.log(`Resuming session: ${options.sessionId}`);
    }
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
    // In 'default' mode, canUseTool callback handles approval, so exclude approve_action
    // to avoid double-approval prompts
    if (permissionMode === 'default') {
      queryOptions.allowedTools = ['mcp__ask-user__ask_user'];
      console.log('MCP ask-user server configured (approve_action disabled - using canUseTool)');
    } else {
      queryOptions.allowedTools = ['mcp__ask-user__ask_user', 'mcp__ask-user__approve_action'];
      console.log('MCP ask-user server configured');
    }
  }

  // Add canUseTool callback for tool approval in default mode
  if (options.canUseTool) {
    queryOptions.canUseTool = options.canUseTool;
    console.log('canUseTool callback configured for manual approval');
  }

  return query({
    prompt,
    options: queryOptions,
  }) as ClaudeQuery;
}

/**
 * @deprecated Use startClaudeQuery instead for abort support
 */
export async function* streamClaude(
  prompt: string,
  options: StreamOptions
): AsyncGenerator<SDKMessage, void, unknown> {
  for await (const message of startClaudeQuery(prompt, options)) {
    yield message;
  }
}
