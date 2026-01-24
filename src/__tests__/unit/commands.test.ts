import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand } from '../../commands.js';
import { Session } from '../../session-manager.js';

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
      expect(result.response).toContain('/fork');
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
    it('should show mode selection buttons with all 4 SDK modes', () => {
      const result = parseCommand('/mode', mockSession);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();

      // Find actions block with buttons
      const actionsBlock = result.blocks!.find(b => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock?.elements?.length).toBe(4);

      // Check button action IDs for SDK mode names
      const actionIds = actionsBlock?.elements?.map((e: any) => e.action_id);
      expect(actionIds).toContain('mode_plan');
      expect(actionIds).toContain('mode_default');
      expect(actionIds).toContain('mode_bypassPermissions');
      expect(actionIds).toContain('mode_acceptEdits');
    });

    it('should highlight current mode button', () => {
      const result = parseCommand('/mode', mockSession);
      const actionsBlock = result.blocks!.find(b => b.type === 'actions');

      // Plan should be primary (current mode)
      const planButton = actionsBlock?.elements?.find((e: any) => e.action_id === 'mode_plan');
      expect(planButton?.style).toBe('primary');

      // Default should not be primary
      const defaultButton = actionsBlock?.elements?.find((e: any) => e.action_id === 'mode_default');
      expect(defaultButton?.style).toBeUndefined();
    });

    it('should redirect to mode picker when arg provided', () => {
      const result = parseCommand('/mode bypassPermissions', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Please use the mode picker');
      expect(result.blocks).toBeDefined();
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should show picker for any typed mode argument', () => {
      const result = parseCommand('/mode default', mockSession);
      expect(result.response).toContain('Please use the mode picker');
      expect(result.blocks).toBeDefined();
    });

    it('should show picker even for invalid mode argument', () => {
      const result = parseCommand('/mode invalid', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Please use the mode picker');
      expect(result.blocks).toBeDefined();
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

  describe('/fork', () => {
    it('should return error when no session ID', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/fork', sessionWithoutId);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No active session');
    });

    it('should show terminal command blocks with fork flag', () => {
      const result = parseCommand('/fork', mockSession);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();

      // Check header
      const headerBlock = result.blocks![0];
      expect(headerBlock.text?.text).toBe('Fork to Terminal');
    });

    it('should include --fork-session flag in command', () => {
      const result = parseCommand('/fork', mockSession);
      const commandBlock = result.blocks!.find(b => b.text?.text?.includes('claude --resume'));

      expect(commandBlock).toBeDefined();
      expect(commandBlock?.text?.text).toContain('--fork-session');
    });

    it('should include note about new session', () => {
      const result = parseCommand('/fork', mockSession);
      const noteBlock = result.blocks!.find(b =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('new session')
      );

      expect(noteBlock).toBeDefined();
    });
  });

  describe('/resume', () => {
    it('should show usage when no session ID provided', () => {
      const result = parseCommand('/resume', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Usage');
      expect(result.response).toContain('/resume <session-id>');
    });

    it('should reject invalid session ID format', () => {
      const result = parseCommand('/resume invalid-id', mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid session ID format');
    });

    it('should accept valid UUID session ID', () => {
      const validUuid = '12345678-1234-1234-1234-123456789012';
      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Resuming session');
      expect(result.sessionUpdate).toEqual({ sessionId: validUuid });
    });

    it('should accept uppercase UUID', () => {
      const validUuid = 'ABCDEF12-1234-5678-9ABC-DEF012345678';
      const result = parseCommand(`/resume ${validUuid}`, mockSession);

      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.sessionId).toBe(validUuid);
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
      expect(result.response).toContain('2s');
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

    it('should show default=2 in help text', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('default=2');
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

  describe('/ff', () => {
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

  describe('/strip-empty-tag', () => {
    it('should show default value (disabled) when not set', () => {
      const result = parseCommand('/strip-empty-tag', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('disabled');
      expect(result.response).toContain('default');
    });

    it('should show enabled when set to true', () => {
      const sessionWithStrip: Session = { ...mockSession, stripEmptyTag: true };
      const result = parseCommand('/strip-empty-tag', sessionWithStrip);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('enabled');
      expect(result.response).not.toContain('default');
    });

    it('should accept true value', () => {
      const result = parseCommand('/strip-empty-tag true', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(true);
      expect(result.response).toContain('enabled');
    });

    it('should accept false value', () => {
      const sessionWithStrip: Session = { ...mockSession, stripEmptyTag: true };
      const result = parseCommand('/strip-empty-tag false', sessionWithStrip);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(false);
      expect(result.response).toContain('disabled');
    });

    it('should accept 1 as true', () => {
      const result = parseCommand('/strip-empty-tag 1', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(true);
    });

    it('should accept 0 as false', () => {
      const result = parseCommand('/strip-empty-tag 0', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(false);
    });

    it('should accept on as true', () => {
      const result = parseCommand('/strip-empty-tag on', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(true);
    });

    it('should accept off as false', () => {
      const result = parseCommand('/strip-empty-tag off', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(false);
    });

    it('should accept yes as true', () => {
      const result = parseCommand('/strip-empty-tag yes', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(true);
    });

    it('should accept no as false', () => {
      const result = parseCommand('/strip-empty-tag no', mockSession);
      expect(result.handled).toBe(true);
      expect(result.sessionUpdate?.stripEmptyTag).toBe(false);
    });

    it('should reject invalid input', () => {
      const result = parseCommand('/strip-empty-tag invalid', mockSession);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid value');
      expect(result.sessionUpdate).toBeUndefined();
    });

    it('should appear in /help output', () => {
      const result = parseCommand('/help', mockSession);
      expect(result.response).toContain('/strip-empty-tag');
      expect(result.response).toContain('true|false');
    });
  });
});
