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

    it('should return a ClaudeQuery with interrupt method', () => {
      const result = startClaudeQuery('test prompt', {});

      expect(result).toBeDefined();
      expect(typeof result.interrupt).toBe('function');
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
