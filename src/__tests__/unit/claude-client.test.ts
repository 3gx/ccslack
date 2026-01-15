import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'test-123' };
    },
    interrupt: vi.fn(),
  }),
}));

import { query } from '@anthropic-ai/claude-code';
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

    it('should set systemPrompt to claude_code', () => {
      startClaudeQuery('test prompt', {});

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: 'claude_code',
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
  });
});
