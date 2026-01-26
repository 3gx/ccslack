import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PermissionMode } from './session-manager.js';
import { ContentBlock } from './content-builder.js';

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
  maxThinkingTokens?: number;  // Extended thinking budget (0 = disabled, undefined = default)
}

// Query type with control methods (from SDK)
export interface ClaudeQuery extends AsyncGenerator<SDKMessage, void, unknown> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
}

/**
 * Start a Claude query and return the Query object.
 * The Query object can be iterated for messages and has an interrupt() method.
 *
 * @param prompt - Either a simple string, ContentBlock[] for multi-modal messages, or null for fork-only (no new message)
 */
export function startClaudeQuery(
  prompt: string | ContentBlock[] | null,
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

  // Add extended thinking tokens if enabled (undefined or > 0)
  // If 0, don't pass to SDK (disables thinking)
  if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens > 0) {
    queryOptions.maxThinkingTokens = options.maxThinkingTokens;
    console.log(`Extended thinking enabled: ${options.maxThinkingTokens} tokens`);
  } else if (options.maxThinkingTokens === 0) {
    console.log('Extended thinking disabled');
  }

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

  // Add canUseTool callback for tool approval in default mode
  if (options.canUseTool) {
    queryOptions.canUseTool = options.canUseTool;
    console.log('canUseTool callback configured for manual approval');
  }

  // Handle fork-only - API rejects empty and whitespace-only text, so use minimal real content
  // marked as synthetic to indicate this is a fork operation, not a real user message
  if (prompt === null) {
    const syntheticMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '.' }] },
      parent_tool_use_id: null,
      session_id: options.sessionId || '',
      isSynthetic: true,
    };

    async function* syntheticStream(): AsyncIterable<SDKUserMessage> {
      yield syntheticMessage;
    }

    console.log('Starting Claude query with synthetic message (fork-only)');
    return query({
      prompt: syntheticStream(),
      options: queryOptions,
    }) as ClaudeQuery;
  }

  // Handle multi-modal content (with images)
  if (Array.isArray(prompt)) {
    // ContentBlock[] - wrap in AsyncIterable<SDKUserMessage> for SDK
    // When forking/resuming, session_id must match the session being used
    // Empty string only works for new sessions
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: options.sessionId || '',
    };

    async function* messageStream(): AsyncIterable<SDKUserMessage> {
      yield userMessage;
    }

    console.log(`Starting Claude query with ${prompt.length} content blocks (multi-modal)`);
    return query({
      prompt: messageStream(),
      options: queryOptions,
    }) as ClaudeQuery;
  }

  // Simple string prompt (existing path)
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
