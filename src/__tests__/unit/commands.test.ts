import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, extractInlineMode, extractMentionMode, extractFirstMentionId } from '../../commands.js';
import { Session } from '../../session-manager.js';

// Mock session-reader for /resume tests
vi.mock('../../session-reader.js', () => ({
  findSessionFile: vi.fn(),
}));

import { findSessionFile } from '../../session-reader.js';

describe('commands', () => {
  // Default test session
  const mockSession: Session = {
    sessionId: 'abc-12345-def-67890-ghijk',
    workingDir: '/Users/testuser/projects/myapp',
    mode: 'plan',
    createdAt: Date.now() - 3600000, // 1 hour ago
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/Users/testuser/projects/myapp',
    configuredBy: 'U123456',
    configuredAt: Date.now() - 7200000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseCommand', () => {
    it('should return handled: false for non-commands', () => {
      const result = parseCommand('hello world', mockSession);
      expect(result.handled).toBe(false);
    });

    it('should return error for unknown commands', () => {
      const result = parseCommand('/unknown', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Unknown command');
      expect(result.response).toContain('/unknown');
    });

    it('should handle commands case-insensitively', () => {
      const result = parseCommand('/STATUS', mockSession);
      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();
    });
  });

  describe('/help', () => {
    it('should return help text with all commands', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Available Commands');
      expect(result.response).toContain('/help');
      expect(result.response).toContain('/ls');
      expect(result.response).toContain('/cd');
      expect(result.response).toContain('/set-current-path');
      expect(result.response).toContain('/status');
      expect(result.response).toContain('/mode');
      expect(result.response).toContain('/watch');
      expect(result.response).toContain('/stop-watching');
      expect(result.response).toContain('/resume');
    });
  });

  describe('/status', () => {
    it('should return status blocks with session info', () => {
      const result = parseCommand('/status', mockSession);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();
      expect(result.blocks!.length).toBeGreaterThan(0);

      // Check header block
      const headerBlock = result.blocks![0];
      expect(headerBlock.type).toBe('header');
      expect(headerBlock.text?.text).toBe('Session Status');
    });

    it('should show session ID in status', () => {
      const result = parseCommand('/status', mockSession);
      const sectionBlock = result.blocks!.find(b => b.type === 'section' && b.text?.text?.includes('Session ID'));

      expect(sectionBlock).toBeDefined();
      expect(sectionBlock?.text?.text).toContain(mockSession.sessionId);
    });

    it('should show terminal detection disabled message', () => {
      const result = parseCommand('/status', mockSession);
      const contextBlock = result.blocks!.find(b => b.type === 'context');

      expect(contextBlock).toBeDefined();
      expect(contextBlock?.elements?.[0]?.text).toContain('Terminal detection');
      expect(contextBlock?.elements?.[0]?.text).toContain('disabled');
    });

    it('should show "None" for sessionId when null', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/status', sessionWithoutId);

      const sectionBlock = result.blocks!.find(b => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('None');
    });
  });

  describe('/mode', () => {
    it('should return showModeSelection flag when no argument provided', () => {
      const result = parseCommand('/mode', mockSession);

      expect(result.handled).toBe(true);
      expect(result.showModeSelection).toBe(true);
      // Blocks are now built in slack-bot.ts handler, not in commands.ts
      expect(result.blocks).toBeUndefined();
    });

    it('should switch to plan mode with /mode plan', () => {
      const result = parseCommand('/mode plan', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.mode).toBe('plan');
      expect(result.response).toContain('Mode set to');
    });

    it('should switch to bypass mode with /mode bypass', () => {
      const result = parseCommand('/mode bypass', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.mode).toBe('bypassPermissions');
      expect(result.response).toContain('Mode set to');
    });

    it('should switch to ask mode with /mode ask', () => {
      const result = parseCommand('/mode ask', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.mode).toBe('default');
      expect(result.response).toContain('Mode set to');
    });

    it('should switch to edit mode with /mode edit', () => {
      const result = parseCommand('/mode edit', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.mode).toBe('acceptEdits');
      expect(result.response).toContain('Mode set to');
    });

    it('should handle mode shortcuts case-insensitively', () => {
      const result = parseCommand('/mode PLAN', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.mode).toBe('plan');
    });

    it('should reject invalid mode argument with usage hint', () => {
      const result = parseCommand('/mode invalid', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Unknown mode');
      expect(result.response).toContain('/mode [plan|bypass|ask|edit]');
      expect(result.sessionUpdate).toBeUndefined();
    });
  });

  describe('/ls', () => {
    it('should list current directory when no arg provided', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        workingDir: '/Users/egx/ai/ccslack',
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/ls', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Files in');
      expect(result.response).toContain('/Users/egx/ai/ccslack');
      expect(result.response).toContain('/cd');
      expect(result.response).toContain('/set-current-path');
    });

    it('should list specific absolute directory', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/ls /tmp', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Files in');
      expect(result.response).toContain('/tmp');
    });

    it('should work after path configured', () => {
      const result = parseCommand('/ls /tmp', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Files in');
      expect(result.response).toContain('/tmp');
      expect(result.response).toContain('locked directory');
    });

    it('should return error when directory does not exist', () => {
      const result = parseCommand('/ls /nonexistent/path', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('does not exist');
      expect(result.response).toContain('/nonexistent/path');
    });

    it('should return error when path is a file, not a directory', () => {
      const result = parseCommand('/ls /etc/hosts', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Not a directory');
      expect(result.response).toContain('/etc/hosts');
    });
  });

  describe('/cd', () => {
    it('should show current directory when no arg provided', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/cd', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Current directory');
      expect(result.response).toContain(unconfiguredSession.workingDir);
      expect(result.response).toContain('/set-current-path');
    });

    it('should change to absolute path', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        workingDir: '/Users/testuser',
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/cd /tmp', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Changed to');
      expect(result.sessionUpdate).toBeDefined();
      // On macOS, /tmp resolves to /private/tmp
      expect(result.sessionUpdate?.workingDir).toMatch(/^\/(?:private\/)?tmp$/);
    });

    it('should be disabled after path locked', () => {
      const result = parseCommand('/cd /tmp', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('disabled');
      expect(result.response).toContain('locked');
      expect(result.response).toContain(mockSession.configuredPath);
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should return error when directory does not exist', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/cd /nonexistent/path', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('does not exist');
    });

    it('should return error when path is a file', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/cd /etc/hosts', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Not a directory');
    });
  });

  describe('/set-current-path', () => {
    it('should lock current working directory', () => {
      const unconfiguredSession: Session = {
        ...mockSession,
        workingDir: '/tmp',
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };
      const result = parseCommand('/set-current-path', unconfiguredSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('locked to');
      expect(result.sessionUpdate).toBeDefined();
      expect(result.sessionUpdate?.pathConfigured).toBe(true);
      // On macOS, /tmp resolves to /private/tmp
      expect(result.sessionUpdate?.configuredPath).toMatch(/^\/(?:private\/)?tmp$/);
      expect(result.sessionUpdate?.workingDir).toMatch(/^\/(?:private\/)?tmp$/);
      expect(result.sessionUpdate?.configuredAt).toBeDefined();
    });

    it('should reject when already locked', () => {
      const result = parseCommand('/set-current-path', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('already locked');
      expect(result.response).toContain(mockSession.configuredPath);
      expect(result.sessionUpdate).toBeUndefined();
    });
  });

  describe('/watch', () => {
    it('should reject when called from a thread', () => {
      const result = parseCommand('/watch', mockSession, 'some-thread-ts');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('can only be used in the main channel');
      expect(result.startTerminalWatch).toBeFalsy();
    });

    it('should allow when called from main channel', () => {
      const result = parseCommand('/watch', mockSession, undefined);

      expect(result.handled).toBe(true);
      expect(result.startTerminalWatch).toBe(true);
    });

    it('should return error when no session ID', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/watch', sessionWithoutId);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No active session');
    });

    it('should show terminal command blocks', () => {
      const result = parseCommand('/watch', mockSession);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();

      // Check header
      const headerBlock = result.blocks![0];
      expect(headerBlock.type).toBe('header');
      expect(headerBlock.text?.text).toBe('Continue in Terminal');
    });

    it('should include full cd && claude command', () => {
      const result = parseCommand('/watch', mockSession);
      const commandBlock = result.blocks!.find(b => b.text?.text?.includes('claude'));

      expect(commandBlock).toBeDefined();
      // Should include cd, --dangerously-skip-permissions, and --resume
      expect(commandBlock?.text?.text).toContain(`cd ${mockSession.workingDir}`);
      expect(commandBlock?.text?.text).toContain('--dangerously-skip-permissions');
      expect(commandBlock?.text?.text).toContain(`--resume ${mockSession.sessionId}`);
    });

    it('should set startTerminalWatch flag', () => {
      const result = parseCommand('/watch', mockSession);

      expect(result.handled).toBe(true);
      expect(result.startTerminalWatch).toBe(true);
    });
  });

  describe('/stop-watching', () => {
    it('should set stopTerminalWatch flag', () => {
      const result = parseCommand('/stop-watching', mockSession);

      expect(result.handled).toBe(true);
      expect(result.stopTerminalWatch).toBe(true);
    });

    it('should not require a session ID', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/stop-watching', sessionWithoutId);

      expect(result.handled).toBe(true);
      expect(result.stopTerminalWatch).toBe(true);
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/stop-watching');
      expect(result.response).toContain('Stop watching terminal session');
    });
  });

  describe('/resume', () => {
    const mockFindSessionFile = findSessionFile as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFindSessionFile.mockReset();
    });

    it('should show usage when no session ID provided', () => {
      const result = parseCommand('/resume', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Usage');
      expect(result.response).toContain('/resume <session-id>');
    });

    it('should reject invalid session ID format', () => {
      const result = parseCommand('/resume invalid-id', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain(':x:');
      expect(result.response).toContain('Invalid session ID format');
    });

    it('should accept valid UUID and sync working directory', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-project/12345678-1234-1234-1234-123456789012.jsonl',
        workingDir: '/tmp/project',
        planFilePath: null,
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Resuming session');
      expect(result.response).toContain('/tmp/project');
      expect(result.sessionUpdate?.sessionId).toBe(validUuid);
      expect(result.sessionUpdate?.workingDir).toBe('/tmp/project');
      expect(result.sessionUpdate?.pathConfigured).toBe(true);
      expect(result.sessionUpdate?.configuredPath).toBe('/tmp/project');
    });

    it('should accept uppercase UUID', () => {
      const validUuid = 'ABCDEF12-1234-5678-9ABC-DEF012345678';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-project/ABCDEF12-1234-5678-9ABC-DEF012345678.jsonl',
        workingDir: '/tmp/project',
        planFilePath: null,
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.sessionId).toBe(validUuid);
    });

    it('should return error when session file not found', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue(null);

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain(':x:');
      expect(result.response).toContain('Session file not found');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should show path locked message for fresh channel', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-newproject/test.jsonl',
        workingDir: '/tmp/newproject',
        planFilePath: null,
      });

      const freshSession: Session = {
        ...mockSession,
        pathConfigured: false,
        configuredPath: null,
      };

      const result = parseCommand(`/resume ${validUuid}`, freshSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Path locked to');
      expect(result.response).toContain('/tmp/newproject');
      expect(result.sessionUpdate?.configuredAt).toBeDefined();
    });

    it('should show path changed message when path differs', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-newpath/test.jsonl',
        workingDir: '/tmp/newpath',
        planFilePath: null,
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Path changed from');
      expect(result.response).toContain(mockSession.configuredPath);
      expect(result.response).toContain('/tmp/newpath');
    });

    it('should not show path changed when paths match', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-Users-testuser-projects-myapp/test.jsonl',
        workingDir: '/Users/testuser/projects/myapp',
        planFilePath: null,
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).not.toContain('Path changed');
      expect(result.response).not.toContain('Path locked');
    });

    it('should include planFilePath in sessionUpdate when present', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-project/test.jsonl',
        workingDir: '/tmp/project',
        planFilePath: '/Users/test/.claude/plans/my-plan.md',
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.planFilePath).toBe('/Users/test/.claude/plans/my-plan.md');
    });

    it('should set planFilePath to null in sessionUpdate when no plan', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      mockFindSessionFile.mockReturnValue({
        filePath: '/home/user/.claude/projects/-tmp-project/test.jsonl',
        workingDir: '/tmp/project',
        planFilePath: null,
      });

      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.planFilePath).toBeNull();
    });
  });

  describe('/compact', () => {
    it('should return compactSession flag when session exists', () => {
      const result = parseCommand('/compact', mockSession);

      expect(result.handled).toBe(true);
      expect(result.compactSession).toBe(true);
    });

    it('should return error when no session', () => {
      const noSessionMock: Session = {
        ...mockSession,
        sessionId: null,
      };
      const result = parseCommand('/compact', noSessionMock);

      expect(result.handled).toBe(true);
      expect(result.compactSession).toBeUndefined();
      expect(result.response).toContain('No active session');
    });

    it('should include /compact in help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/compact');
    });
  });

  describe('/clear', () => {
    it('should return clearSession flag when session exists', () => {
      const result = parseCommand('/clear', mockSession);

      expect(result.handled).toBe(true);
      expect(result.clearSession).toBe(true);
    });

    it('should return error when no session', () => {
      const noSessionMock: Session = {
        ...mockSession,
        sessionId: null,
      };
      const result = parseCommand('/clear', noSessionMock);

      expect(result.handled).toBe(true);
      expect(result.clearSession).toBeUndefined();
      expect(result.response).toContain('No active session');
    });

    it('should include /clear in help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/clear');
    });
  });

  describe('/context', () => {
    it('should return error when no usage data', () => {
      const result = parseCommand('/context', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No context data available');
    });

    it('should return context blocks when usage data exists', () => {
      const sessionWithUsage: Session = {
        ...mockSession,
        lastUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 45000,
          contextWindow: 200000,
          model: 'claude-sonnet-4-5-20250929',
        },
      };
      const result = parseCommand('/context', sessionWithUsage);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();
      expect(result.blocks!.length).toBeGreaterThan(0);

      // Check header block
      const headerBlock = result.blocks![0];
      expect(headerBlock.type).toBe('header');
      expect(headerBlock.text?.text).toBe('Context Usage');
    });

    it('should include /context in help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/context');
    });
  });

  describe('/status with lastUsage', () => {
    it('should include model and context info when lastUsage exists', () => {
      const sessionWithUsage: Session = {
        ...mockSession,
        lastUsage: {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 95000,
          contextWindow: 200000,
          model: 'claude-opus-4-5-20251101',
        },
      };
      const result = parseCommand('/status', sessionWithUsage);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();

      // Find section with status lines
      const sectionBlock = result.blocks!.find(b => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('claude-opus-4-5-20251101');
      expect(sectionBlock?.text?.text).toContain('Context:');
      expect(sectionBlock?.text?.text).toContain('50%'); // (5000 + 95000) / 200000 = 50%
    });
  });

  describe('/max-thinking-tokens', () => {
    it('should show default value when not set', () => {
      const result = parseCommand('/max-thinking-tokens', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('31,999');
      expect(result.response).toContain('default');
    });

    it('should show current value when set', () => {
      const sessionWithThinking: Session = { ...mockSession, maxThinkingTokens: 16000 };
      const result = parseCommand('/max-thinking-tokens', sessionWithThinking);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('16,000');
      expect(result.response).not.toContain('default');
    });

    it('should show disabled when set to 0', () => {
      const sessionDisabled: Session = { ...mockSession, maxThinkingTokens: 0 };
      const result = parseCommand('/max-thinking-tokens', sessionDisabled);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('disabled');
    });

    it('should accept 0 to disable thinking', () => {
      const result = parseCommand('/max-thinking-tokens 0', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.maxThinkingTokens).toBe(0);
      expect(result.response).toContain('disabled');
    });

    it('should reject values below minimum (1-1023)', () => {
      const result = parseCommand('/max-thinking-tokens 500', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Minimum is 1,024');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should accept minimum value (1024)', () => {
      const result = parseCommand('/max-thinking-tokens 1024', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.maxThinkingTokens).toBe(1024);
    });

    it('should accept maximum value (128000)', () => {
      const result = parseCommand('/max-thinking-tokens 128000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.maxThinkingTokens).toBe(128000);
    });

    it('should reject values above maximum', () => {
      const result = parseCommand('/max-thinking-tokens 200000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Maximum is 128,000');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should reject non-numeric input', () => {
      const result = parseCommand('/max-thinking-tokens abc', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid value');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/max-thinking-tokens');
      expect(result.response).toContain('0=disable');
      expect(result.response).toContain('1024-128000');
    });

    it('should accept value in valid range', () => {
      const result = parseCommand('/max-thinking-tokens 50000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.maxThinkingTokens).toBe(50000);
      expect(result.response).toContain('50,000');
    });
  });

  describe('/update-rate', () => {
    it('should show default value when not set', () => {
      const result = parseCommand('/update-rate', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('3s');
      expect(result.response).toContain('default');
    });

    it('should show current value when set', () => {
      const sessionWithRate: Session = { ...mockSession, updateRateSeconds: 2.5 };
      const result = parseCommand('/update-rate', sessionWithRate);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('2.5s');
      expect(result.response).not.toContain('default');
    });

    it('should accept minimum value (1)', () => {
      const result = parseCommand('/update-rate 1', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.updateRateSeconds).toBe(1);
      expect(result.response).toContain('1s');
    });

    it('should accept maximum value (10)', () => {
      const result = parseCommand('/update-rate 10', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.updateRateSeconds).toBe(10);
      expect(result.response).toContain('10s');
    });

    it('should accept fractional values', () => {
      const result = parseCommand('/update-rate 1.5', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.updateRateSeconds).toBe(1.5);
      expect(result.response).toContain('1.5s');
    });

    it('should accept other fractional values', () => {
      const result = parseCommand('/update-rate 2.75', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.updateRateSeconds).toBe(2.75);
      expect(result.response).toContain('2.75s');
    });

    it('should reject values below minimum', () => {
      const result = parseCommand('/update-rate 0.5', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Minimum is 1');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should reject values above maximum', () => {
      const result = parseCommand('/update-rate 15', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Maximum is 10');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should reject non-numeric input', () => {
      const result = parseCommand('/update-rate abc', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid value');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/update-rate');
      expect(result.response).toContain('1-10');
    });

    it('should show default=3 in help text', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('default=3');
    });
  });

  describe('/message-size', () => {
    it('should show default value when not set', () => {
      const result = parseCommand('/message-size', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('500');
      expect(result.response).toContain('default');
    });

    it('should show current value when set', () => {
      const sessionWithLimit: Session = { ...mockSession, threadCharLimit: 1000 };
      const result = parseCommand('/message-size', sessionWithLimit);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('1000');
      expect(result.response).not.toContain('default');
    });

    it('should accept minimum value (100)', () => {
      const result = parseCommand('/message-size 100', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.threadCharLimit).toBe(100);
      expect(result.response).toContain('100');
    });

    it('should accept maximum value (36000)', () => {
      const result = parseCommand('/message-size 36000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.threadCharLimit).toBe(36000);
      expect(result.response).toContain('36000');
    });

    it('should accept value in valid range', () => {
      const result = parseCommand('/message-size 800', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.threadCharLimit).toBe(800);
      expect(result.response).toContain('800');
    });

    it('should reject values below minimum', () => {
      const result = parseCommand('/message-size 50', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('between 100 and 36000');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should reject values above maximum', () => {
      const result = parseCommand('/message-size 50000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('between 100 and 36000');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should reject non-numeric input', () => {
      const result = parseCommand('/message-size abc', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid number');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/message-size');
      expect(result.response).toContain('100-36000');
    });
  });

  describe.skip('/ff', () => {
    it('should reject when called from a thread', () => {
      const result = parseCommand('/ff', mockSession, 'some-thread-ts');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('can only be used in the main channel');
      expect(result.fastForward).toBeFalsy();
    });

    it('should allow when called from main channel', () => {
      const result = parseCommand('/ff', mockSession, undefined);

      expect(result.handled).toBe(true);
      expect(result.fastForward).toBe(true);
    });

    it('should return error when no session ID', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/ff', sessionWithoutId);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No active session');
      expect(result.fastForward).toBeUndefined();
    });

    it('should set fastForward flag with valid session', () => {
      const result = parseCommand('/ff', mockSession);

      expect(result.handled).toBe(true);
      expect(result.fastForward).toBe(true);
    });

    it('should accept /fast-forward alias', () => {
      const result = parseCommand('/fast-forward', mockSession);

      expect(result.handled).toBe(true);
      expect(result.fastForward).toBe(true);
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/ff');
      expect(result.response).toContain('Fast-forward');
    });
  });

  describe('/cwd', () => {
    it('should return error when no working directory', () => {
      const sessionWithoutDir: Session = { ...mockSession, workingDir: '' };
      const result = parseCommand('/cwd', sessionWithoutDir);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('No working directory set');
    });

    it('should return current working directory', () => {
      const result = parseCommand('/cwd', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBeUndefined();
      expect(result.response).toContain('Current working directory');
      expect(result.response).toContain(mockSession.workingDir);
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/cwd');
    });
  });

  describe('/show-plan', () => {
    it('should return error when no plan file path', () => {
      const result = parseCommand('/show-plan', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No plan file found');
      expect(result.showPlan).toBeUndefined();
    });

    it('should return showPlan flag when plan file exists', () => {
      const sessionWithPlan: Session = {
        ...mockSession,
        planFilePath: '/home/user/.claude/plans/my-plan.md',
      };
      const result = parseCommand('/show-plan', sessionWithPlan);
      expect(result.handled).toBe(true);
      expect(result.showPlan).toBe(true);
      expect(result.planFilePath).toBe('/home/user/.claude/plans/my-plan.md');
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/show-plan');
    });
  });

  describe('extractInlineMode', () => {
    it('should return text unchanged when no /mode present', () => {
      const result = extractInlineMode('hello world');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('hello world');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode plan at start', () => {
      const result = extractInlineMode('/mode plan help me design a feature');
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('help me design a feature');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode bypass at start', () => {
      const result = extractInlineMode('/mode bypass fix this bug quickly');
      expect(result.mode).toBe('bypassPermissions');
      expect(result.remainingText).toBe('fix this bug quickly');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode ask at start', () => {
      const result = extractInlineMode('/mode ask review this code');
      expect(result.mode).toBe('default');
      expect(result.remainingText).toBe('review this code');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode edit at start', () => {
      const result = extractInlineMode('/mode edit refactor the function');
      expect(result.mode).toBe('acceptEdits');
      expect(result.remainingText).toBe('refactor the function');
      expect(result.error).toBeUndefined();
    });

    it('should ignore /mode in middle of text', () => {
      const result = extractInlineMode('hello /mode plan world');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('hello /mode plan world');
      expect(result.error).toBeUndefined();
    });

    it('should be case insensitive', () => {
      const result = extractInlineMode('/MODE PLAN test');
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('test');
      expect(result.error).toBeUndefined();
    });

    it('should return error for invalid mode', () => {
      const result = extractInlineMode('/mode invalid do something');
      expect(result.mode).toBeUndefined();
      expect(result.error).toContain('Unknown mode');
      expect(result.error).toContain('invalid');
      expect(result.error).toContain('plan, bypass, ask, edit');
    });

    it('should handle standalone /mode with valid mode', () => {
      const result = extractInlineMode('/mode plan');
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should normalize multiple spaces', () => {
      const result = extractInlineMode('/mode   plan   hello   world');
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('hello world');
      expect(result.error).toBeUndefined();
    });

    it('should only match first occurrence', () => {
      const result = extractInlineMode('/mode plan then /mode bypass');
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('then /mode bypass');
      expect(result.error).toBeUndefined();
    });

    it('should not match /moderation as /mode', () => {
      const result = extractInlineMode('/moderation policy');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('/moderation policy');
      expect(result.error).toBeUndefined();
    });

    it('should handle /mode without argument - treated as no match', () => {
      // /mode followed by nothing - the regex requires \S+ after /mode
      // So this should not match, leaving text unchanged
      const result = extractInlineMode('/mode');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('/mode');
      expect(result.error).toBeUndefined();
    });

    it('should ignore /mode invalid in middle of text (no error)', () => {
      const result = extractInlineMode('what does /mode xyz mean?');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('what does /mode xyz mean?');
      expect(result.error).toBeUndefined();
    });

    it('should ignore valid /mode in middle of text', () => {
      const result = extractInlineMode('explain the /mode plan option');
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('explain the /mode plan option');
      expect(result.error).toBeUndefined();
    });
  });

  describe('command error flags', () => {
    it('should return isError: true for unknown command', () => {
      const result = parseCommand('/unknown-cmd', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('Unknown command');
    });

    it('should return isError: true for invalid /mode argument', () => {
      const result = parseCommand('/mode invalid', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('Unknown mode');
    });

    it('should NOT return isError for successful /help command', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBeUndefined();
    });

    it('should return isError: true for /watch from thread', () => {
      const result = parseCommand('/watch', mockSession, 'thread-ts-123');
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('main channel');
    });

    it('should return isError: true for /watch with no session', () => {
      const noSessionMock = { ...mockSession, sessionId: '' };
      const result = parseCommand('/watch', noSessionMock);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('No active session');
    });

    it('should return isError: true for /ff from thread', () => {
      const result = parseCommand('/ff', mockSession, 'thread-ts-123');
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('main channel');
    });

    it('should return isError: true for invalid /max-thinking-tokens value', () => {
      const result = parseCommand('/max-thinking-tokens abc', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
    });

    it('should return isError: true for /max-thinking-tokens below minimum', () => {
      const result = parseCommand('/max-thinking-tokens 100', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('Minimum');
    });

    it('should return isError: true for /max-thinking-tokens above maximum', () => {
      const result = parseCommand('/max-thinking-tokens 999999', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('Maximum');
    });

    it('should NOT return isError for valid /max-thinking-tokens', () => {
      const result = parseCommand('/max-thinking-tokens 10000', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBeUndefined();
    });

    it('should return isError: true for invalid /update-rate value', () => {
      const result = parseCommand('/update-rate 99', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
    });

    it('should return isError: true for /context with no data', () => {
      const noUsageSession = { ...mockSession, lastUsage: undefined };
      const result = parseCommand('/context', noUsageSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('No context data');
    });

    it('should return isError: true for /compact with no session', () => {
      const noSessionMock = { ...mockSession, sessionId: '' };
      const result = parseCommand('/compact', noSessionMock);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
    });

    it('should return isError: true for /clear with no session', () => {
      const noSessionMock = { ...mockSession, sessionId: '' };
      const result = parseCommand('/clear', noSessionMock);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
    });

    it('should return isError: true for /show-plan with no plan file', () => {
      const noPlanSession = { ...mockSession, planFilePath: undefined };
      const result = parseCommand('/show-plan', noPlanSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('No plan file');
    });

    it('should return isError: true for /resume with invalid format', () => {
      const result = parseCommand('/resume invalid-format', mockSession);
      expect(result.handled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.response).toContain('Invalid session ID');
    });
  });

  describe('extractMentionMode', () => {
    const botUserId = 'U12345BOT';

    it('should extract /mode when directly after @bot', () => {
      const result = extractMentionMode(`<@${botUserId}> /mode plan do something`, botUserId);
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('do something');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode when @bot is in middle of text', () => {
      const result = extractMentionMode(`hello <@${botUserId}> /mode plan world`, botUserId);
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('hello world');
      expect(result.error).toBeUndefined();
    });

    it('should extract /mode when @bot /mode is at end', () => {
      const result = extractMentionMode(`do this <@${botUserId}> /mode bypass`, botUserId);
      expect(result.mode).toBe('bypassPermissions');
      expect(result.remainingText).toBe('do this');
      expect(result.error).toBeUndefined();
    });

    it('should NOT match /mode when text between @bot and /mode', () => {
      const result = extractMentionMode(`<@${botUserId}> blah /mode plan`, botUserId);
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('blah /mode plan');  // /mode stays in text
      expect(result.error).toBeUndefined();
    });

    it('should NOT match /mode without @bot before it', () => {
      const result = extractMentionMode('what does /mode plan do', botUserId);
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('what does /mode plan do');
      expect(result.error).toBeUndefined();
    });

    it('should use LAST @bot /mode when multiple exist', () => {
      const result = extractMentionMode(
        `<@${botUserId}> /mode plan then <@${botUserId}> /mode bypass`,
        botUserId
      );
      expect(result.mode).toBe('bypassPermissions');
      expect(result.remainingText).toBe('then');
      expect(result.error).toBeUndefined();
    });

    it('should error if last @bot /mode is invalid', () => {
      const result = extractMentionMode(
        `<@${botUserId}> /mode plan <@${botUserId}> /mode invalid`,
        botUserId
      );
      expect(result.mode).toBeUndefined();
      expect(result.error).toContain('Unknown mode');
      expect(result.error).toContain('invalid');
    });

    it('should use last valid mode even if earlier ones are invalid', () => {
      const result = extractMentionMode(
        `<@${botUserId}> /mode invalid <@${botUserId}> /mode plan`,
        botUserId
      );
      expect(result.mode).toBe('plan');
      expect(result.error).toBeUndefined();
    });

    it('should strip all @bot mentions from remaining text', () => {
      const result = extractMentionMode(
        `hey <@OTHER123> <@${botUserId}> /mode plan do stuff`,
        botUserId
      );
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('hey do stuff');  // Both mentions stripped
      expect(result.error).toBeUndefined();
    });

    it('should NOT match /moderation', () => {
      const result = extractMentionMode(`<@${botUserId}> /moderation policy`, botUserId);
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('/moderation policy');
      expect(result.error).toBeUndefined();
    });

    it('should NOT match /mode without argument', () => {
      const result = extractMentionMode(`<@${botUserId}> /mode`, botUserId);
      expect(result.mode).toBeUndefined();
      expect(result.remainingText).toBe('/mode');
      expect(result.error).toBeUndefined();
    });

    it('should be case insensitive for mode', () => {
      const result = extractMentionMode(`<@${botUserId}> /MODE PLAN test`, botUserId);
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('test');
      expect(result.error).toBeUndefined();
    });

    it('should handle no spaces between @bot and /mode', () => {
      const result = extractMentionMode(`<@${botUserId}>/mode plan test`, botUserId);
      expect(result.mode).toBe('plan');
      expect(result.remainingText).toBe('test');
      expect(result.error).toBeUndefined();
    });

    it('should only match OUR bot ID, not other bots', () => {
      const result = extractMentionMode(`<@OTHER123> /mode plan <@${botUserId}> hello`, botUserId);
      expect(result.mode).toBeUndefined();  // /mode follows OTHER, not our bot
      expect(result.remainingText).toBe('/mode plan hello');
      expect(result.error).toBeUndefined();
    });
  });

  describe('extractFirstMentionId', () => {
    it('should extract first mention ID', () => {
      expect(extractFirstMentionId('<@U12345> hello')).toBe('U12345');
    });

    it('should return undefined for no mentions', () => {
      expect(extractFirstMentionId('hello world')).toBeUndefined();
    });

    it('should handle multiple mentions', () => {
      expect(extractFirstMentionId('<@FIRST> <@SECOND>')).toBe('FIRST');
    });
  });
});
