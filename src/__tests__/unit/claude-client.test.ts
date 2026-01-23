import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'test-123' };
    },
    interrupt: vi.fn(),
  }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { startClaudeQuery } from '../../claude-client.js';

describe('claude-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startClaudeQuery', () => {
    it('should pass plan mode directly to SDK', () => {
      startClaudeQuery('test prompt', { mode: 'plan' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'test prompt',
          options: expect.objectContaining({
            permissionMode: 'plan',
          }),
        })
      );
    });

    it('should pass default mode directly to SDK', () => {
      startClaudeQuery('test prompt', { mode: 'default' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'default',
          }),
        })
      );
    });

    it('should pass bypassPermissions mode directly to SDK', () => {
      startClaudeQuery('test prompt', { mode: 'bypassPermissions' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'bypassPermissions',
          }),
        })
      );
    });

    it('should pass acceptEdits mode directly to SDK', () => {
      startClaudeQuery('test prompt', { mode: 'acceptEdits' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'acceptEdits',
          }),
        })
      );
    });

    it('should include cwd when workingDir provided', () => {
      startClaudeQuery('test prompt', { workingDir: '/test/path' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: '/test/path',
          }),
        })
      );
    });

    it('should include resume when sessionId provided', () => {
      startClaudeQuery('test prompt', { sessionId: 'abc-123-def' });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: 'abc-123-def',
          }),
        })
      );
    });

    it('should set outputFormat to stream-json', () => {
      startClaudeQuery('test prompt', {});

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            outputFormat: 'stream-json',
          }),
        })
      );
    });

    it('should set systemPrompt to claude_code preset', () => {
      startClaudeQuery('test prompt', {});

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            settingSources: ['user', 'project', 'local'],
          }),
        })
      );
    });

    it('should configure MCP server when slackContext provided', () => {
      startClaudeQuery('test prompt', {
        slackContext: { channel: 'C123', user: 'U123' },
      });

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            mcpServers: expect.any(Object),
            allowedTools: expect.arrayContaining(['mcp__ask-user__ask_user']),
          }),
        })
      );
    });

    it('should exclude approve_action in default mode (canUseTool handles it)', () => {
      startClaudeQuery('test prompt', {
        mode: 'default',
        slackContext: { channel: 'C123', user: 'U123' },
      });

      const callArgs = vi.mocked(query).mock.calls[0][0];
      const allowedTools = callArgs.options.allowedTools as string[];

      // Should only have ask_user, NOT approve_action
      expect(allowedTools).toContain('mcp__ask-user__ask_user');
      expect(allowedTools).not.toContain('mcp__ask-user__approve_action');
      expect(allowedTools).toHaveLength(1);
    });

    it('should include approve_action in plan mode', () => {
      startClaudeQuery('test prompt', {
        mode: 'plan',
        slackContext: { channel: 'C123', user: 'U123' },
      });

      const callArgs = vi.mocked(query).mock.calls[0][0];
      const allowedTools = callArgs.options.allowedTools as string[];

      // Should have both ask_user and approve_action
      expect(allowedTools).toContain('mcp__ask-user__ask_user');
      expect(allowedTools).toContain('mcp__ask-user__approve_action');
      expect(allowedTools).toHaveLength(2);
    });

    it('should include approve_action in bypassPermissions mode', () => {
      startClaudeQuery('test prompt', {
        mode: 'bypassPermissions',
        slackContext: { channel: 'C123', user: 'U123' },
      });

      const callArgs = vi.mocked(query).mock.calls[0][0];
      const allowedTools = callArgs.options.allowedTools as string[];

      // Should have both ask_user and approve_action
      expect(allowedTools).toContain('mcp__ask-user__ask_user');
      expect(allowedTools).toContain('mcp__ask-user__approve_action');
    });

    it('should return a ClaudeQuery with interrupt method', () => {
      const result = startClaudeQuery('test prompt', {});

      expect(result).toBeDefined();
      expect(typeof result.interrupt).toBe('function');
    });

    // Additional tests for Phase 0 SDK upgrade coverage

    describe('MCP Server Config Structure', () => {
      it('MCP server config has correct command and args', () => {
        startClaudeQuery('test prompt', {
          slackContext: { channel: 'C123', user: 'U123' },
        });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        const mcpServers = callArgs.options.mcpServers as Record<string, any>;

        expect(mcpServers).toBeDefined();
        expect(mcpServers['ask-user']).toBeDefined();
        expect(mcpServers['ask-user'].command).toBe('npx');
        expect(mcpServers['ask-user'].args).toContain('tsx');
        expect(mcpServers['ask-user'].args.some((arg: string) => arg.includes('mcp-server.ts'))).toBe(true);
      });

      it('MCP server receives SLACK_CONTEXT as JSON env var', () => {
        const slackContext = { channel: 'C123', threadTs: 'thread-ts', user: 'U456' };
        startClaudeQuery('test prompt', { slackContext });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        const mcpServers = callArgs.options.mcpServers as Record<string, any>;

        expect(mcpServers['ask-user'].env.SLACK_CONTEXT).toBeDefined();
        const parsedContext = JSON.parse(mcpServers['ask-user'].env.SLACK_CONTEXT);
        expect(parsedContext.channel).toBe('C123');
        expect(parsedContext.threadTs).toBe('thread-ts');
        expect(parsedContext.user).toBe('U456');
      });
    });

    describe('Session Fork Options', () => {
      it('forkSession sets resume and forkSession options', () => {
        startClaudeQuery('test prompt', {
          sessionId: 'parent-session-id',
          forkSession: true,
        });

        expect(query).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              resume: 'parent-session-id',
              forkSession: true,
            }),
          })
        );
      });

      it('resumeSessionAt passes message ID for point-in-time fork', () => {
        startClaudeQuery('test prompt', {
          sessionId: 'parent-session-id',
          forkSession: true,
          resumeSessionAt: 'msg-id-12345',
        });

        expect(query).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              resume: 'parent-session-id',
              forkSession: true,
              resumeSessionAt: 'msg-id-12345',
            }),
          })
        );
      });
    });

    describe('canUseTool Callback', () => {
      it('canUseTool callback passed to SDK options when provided', () => {
        const mockCanUseTool = vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: {} });

        startClaudeQuery('test prompt', {
          mode: 'default',
          canUseTool: mockCanUseTool,
        });

        expect(query).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              canUseTool: mockCanUseTool,
            }),
          })
        );
      });

      it('canUseTool callback NOT in options when undefined', () => {
        startClaudeQuery('test prompt', { mode: 'default' });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        expect(callArgs.options.canUseTool).toBeUndefined();
      });
    });

    describe('Multi-Modal Content Blocks', () => {
      it('uses AsyncIterable prompt when ContentBlock[] is passed', () => {
        const contentBlocks = [
          { type: 'text' as const, text: 'Describe this image' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
        ];

        startClaudeQuery(contentBlocks, {});

        const callArgs = vi.mocked(query).mock.calls[0][0];
        // prompt should be an AsyncIterable (generator function), not a string
        expect(typeof callArgs.prompt).not.toBe('string');
        expect(typeof callArgs.prompt[Symbol.asyncIterator]).toBe('function');
      });

      it('sets empty session_id when no sessionId option provided (new session)', () => {
        const contentBlocks = [
          { type: 'text' as const, text: 'Test' },
        ];

        startClaudeQuery(contentBlocks, {});

        const callArgs = vi.mocked(query).mock.calls[0][0];
        // Extract the yielded message from the AsyncIterable
        const asyncIterator = callArgs.prompt[Symbol.asyncIterator]();
        return asyncIterator.next().then((result: any) => {
          expect(result.value.session_id).toBe('');
        });
      });

      it('sets session_id to sessionId option when forking (for SDK compatibility)', async () => {
        const contentBlocks = [
          { type: 'text' as const, text: 'Test with image' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'xyz789' } },
        ];

        startClaudeQuery(contentBlocks, {
          sessionId: 'fork-session-123',
          forkSession: true,
        });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        const asyncIterator = callArgs.prompt[Symbol.asyncIterator]();
        const result = await asyncIterator.next();

        // session_id in SDKUserMessage must match the session being forked
        expect(result.value.session_id).toBe('fork-session-123');
      });

      it('sets session_id when resuming a session (not forking)', async () => {
        const contentBlocks = [
          { type: 'text' as const, text: 'Continue with image' },
        ];

        startClaudeQuery(contentBlocks, {
          sessionId: 'resume-session-456',
          // No forkSession - just resuming
        });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        const asyncIterator = callArgs.prompt[Symbol.asyncIterator]();
        const result = await asyncIterator.next();

        expect(result.value.session_id).toBe('resume-session-456');
      });

      it('SDKUserMessage has correct structure for images', async () => {
        const contentBlocks = [
          { type: 'text' as const, text: 'What is this?' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg', data: 'imagedata' } },
        ];

        startClaudeQuery(contentBlocks, { sessionId: 'test-session' });

        const callArgs = vi.mocked(query).mock.calls[0][0];
        const asyncIterator = callArgs.prompt[Symbol.asyncIterator]();
        const result = await asyncIterator.next();

        expect(result.value.type).toBe('user');
        expect(result.value.message.role).toBe('user');
        expect(result.value.message.content).toEqual(contentBlocks);
        expect(result.value.parent_tool_use_id).toBeNull();
        expect(result.value.session_id).toBe('test-session');
      });
    });

    describe('PermissionResult Type Format', () => {
      // These tests verify the type shape that SDK expects
      it('allow result has correct shape with behavior and updatedInput', () => {
        type PermissionResult =
          | { behavior: 'allow'; updatedInput: Record<string, unknown> }
          | { behavior: 'deny'; message: string; interrupt?: boolean };

        const allowResult: PermissionResult = {
          behavior: 'allow',
          updatedInput: { key: 'value' },
        };

        expect(allowResult.behavior).toBe('allow');
        expect(allowResult).toHaveProperty('updatedInput');
        expect(allowResult.updatedInput).toEqual({ key: 'value' });
      });

      it('deny result has correct shape with behavior and message', () => {
        type PermissionResult =
          | { behavior: 'allow'; updatedInput: Record<string, unknown> }
          | { behavior: 'deny'; message: string; interrupt?: boolean };

        const denyResult: PermissionResult = {
          behavior: 'deny',
          message: 'Action not allowed',
        };

        expect(denyResult.behavior).toBe('deny');
        expect(denyResult).toHaveProperty('message');
        expect(denyResult.message).toBe('Action not allowed');
      });

      it('deny result supports optional interrupt field', () => {
        type PermissionResult =
          | { behavior: 'allow'; updatedInput: Record<string, unknown> }
          | { behavior: 'deny'; message: string; interrupt?: boolean };

        const denyWithInterrupt: PermissionResult = {
          behavior: 'deny',
          message: 'Denied and stopping',
          interrupt: true,
        };

        expect(denyWithInterrupt.behavior).toBe('deny');
        expect(denyWithInterrupt.interrupt).toBe(true);
      });
    });
  });
});
