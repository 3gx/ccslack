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
      expect(result.response).toContain('/continue');
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

  describe('/continue', () => {
    it('should return error when no session ID', () => {
      const sessionWithoutId: Session = { ...mockSession, sessionId: null };
      const result = parseCommand('/continue', sessionWithoutId);

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No active session');
    });

    it('should show terminal command blocks', () => {
      const result = parseCommand('/continue', mockSession);

      expect(result.handled).toBe(true);
      expect(result.blocks).toBeDefined();

      // Check header
      const headerBlock = result.blocks![0];
      expect(headerBlock.type).toBe('header');
      expect(headerBlock.text?.text).toBe('Continue in Terminal');
    });

    it('should include resume command', () => {
      const result = parseCommand('/continue', mockSession);
      const commandBlock = result.blocks!.find(b => b.text?.text?.includes('claude --resume'));

      expect(commandBlock).toBeDefined();
      expect(commandBlock?.text?.text).toContain(`claude --resume ${mockSession.sessionId}`);
    });

    it('should show working directory in context', () => {
      const result = parseCommand('/continue', mockSession);
      const contextBlock = result.blocks!.find(b => b.type === 'context');

      expect(contextBlock).toBeDefined();
      expect(contextBlock?.elements?.[0]?.text).toContain(mockSession.workingDir);
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

  describe('/fork-thread', () => {
    it('should return forkThread with description', () => {
      const result = parseCommand('/fork-thread "try async approach"', mockSession);

      expect(result.handled).toBe(true);
      expect(result.forkThread).toBeDefined();
      expect(result.forkThread?.description).toBe('try async approach');
    });

    it('should strip quotes from description', () => {
      const result = parseCommand("/fork-thread 'single quotes work too'", mockSession);

      expect(result.forkThread?.description).toBe('single quotes work too');
    });

    it('should handle description without quotes', () => {
      const result = parseCommand('/fork-thread try puppeteer instead', mockSession);

      expect(result.forkThread?.description).toBe('try puppeteer instead');
    });

    it('should use default description when none provided', () => {
      const result = parseCommand('/fork-thread', mockSession);

      expect(result.handled).toBe(true);
      expect(result.forkThread).toBeDefined();
      expect(result.forkThread?.description).toBe('Exploring alternative approach');
    });

    it('should include /fork-thread in help output', () => {
      const result = parseCommand('/help', mockSession);

      expect(result.response).toContain('/fork-thread');
    });
  });
});
