import { describe, it, expect } from 'vitest';
import {
  isSessionActiveInTerminal,
  getContinueCommand,
  buildConcurrentWarningBlocks,
} from '../../concurrent-check.js';

describe('concurrent-check', () => {
  describe('isSessionActiveInTerminal', () => {
    it('should return active: false (currently disabled)', async () => {
      const result = await isSessionActiveInTerminal('session-123', '/test');
      expect(result).toEqual({ active: false });
    });

    it('should return active: false even with empty sessionId', async () => {
      const result = await isSessionActiveInTerminal('', '/test');
      expect(result).toEqual({ active: false });
    });

    it('should return active: false without workingDir', async () => {
      const result = await isSessionActiveInTerminal('session-123');
      expect(result).toEqual({ active: false });
    });
  });

  describe('getContinueCommand', () => {
    it('should return claude --resume command', () => {
      const cmd = getContinueCommand('abc-123-def');
      expect(cmd).toBe('claude --resume abc-123-def');
    });

    it('should include the full sessionId', () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const cmd = getContinueCommand(sessionId);
      expect(cmd).toBe(`claude --resume ${sessionId}`);
    });
  });

  describe('buildConcurrentWarningBlocks', () => {
    it('should include warning with PID', () => {
      const blocks = buildConcurrentWarningBlocks(12345, 'session-123');
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text.text).toContain('12345');
      expect(blocks[0].text.text).toContain('Warning');
    });

    it('should include context explaining conflict risk', () => {
      const blocks = buildConcurrentWarningBlocks(12345, 'session-123');
      expect(blocks[1].type).toBe('context');
      expect(blocks[1].elements[0].text).toContain('conflicts');
    });

    it('should include Cancel button', () => {
      const blocks = buildConcurrentWarningBlocks(12345, 'session-123');
      const actions = blocks.find((b: any) => b.type === 'actions');
      expect(actions).toBeDefined();
      expect(actions.elements[0].text.text).toBe('Cancel');
      expect(actions.elements[0].action_id).toBe('concurrent_cancel_session-123');
    });

    it('should include Proceed button with danger style', () => {
      const blocks = buildConcurrentWarningBlocks(12345, 'session-123');
      const actions = blocks.find((b: any) => b.type === 'actions');
      expect(actions.elements[1].text.text).toBe('Proceed Anyway');
      expect(actions.elements[1].style).toBe('danger');
      expect(actions.elements[1].action_id).toBe('concurrent_proceed_session-123');
    });

    it('should use sessionId in block_id', () => {
      const blocks = buildConcurrentWarningBlocks(12345, 'my-session');
      const actions = blocks.find((b: any) => b.type === 'actions');
      expect(actions.block_id).toBe('concurrent_my-session');
    });
  });
});
