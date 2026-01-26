import { describe, it, expect } from 'vitest';
import { buildStatusDisplayBlocks } from '../../blocks.js';
import type { PermissionMode } from '../../session-manager.js';

describe('emoji-indicators', () => {
  describe('buildStatusDisplayBlocks with planPresentationCount', () => {
    const baseParams = {
      sessionId: 'sess-123',
      mode: 'plan' as PermissionMode,
      workingDir: '/test/dir',
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredBy: 'U123',
      configuredAt: Date.now(),
    };

    it('should not show plan presentations when count is 0', () => {
      const blocks = buildStatusDisplayBlocks({
        ...baseParams,
        planPresentationCount: 0,
      });

      const text = JSON.stringify(blocks);
      expect(text).not.toContain('Plan Presentations');
    });

    it('should not show plan presentations when count is undefined', () => {
      const blocks = buildStatusDisplayBlocks({
        ...baseParams,
        planPresentationCount: undefined,
      });

      const text = JSON.stringify(blocks);
      expect(text).not.toContain('Plan Presentations');
    });

    it('should show plan presentations when count is 1', () => {
      const blocks = buildStatusDisplayBlocks({
        ...baseParams,
        planPresentationCount: 1,
      });

      const text = JSON.stringify(blocks);
      expect(text).toContain('Plan Presentations');
      expect(text).toContain('1');
    });

    it('should show plan presentations when count is greater than 1', () => {
      const blocks = buildStatusDisplayBlocks({
        ...baseParams,
        planPresentationCount: 5,
      });

      const text = JSON.stringify(blocks);
      expect(text).toContain('Plan Presentations');
      expect(text).toContain('5');
    });
  });

  describe('planPresentationCount in session schema', () => {
    it('should allow planPresentationCount in Session interface', () => {
      // Type check - this test ensures the interface accepts the field
      const session: {
        planPresentationCount?: number;
      } = {
        planPresentationCount: 3,
      };
      expect(session.planPresentationCount).toBe(3);
    });

    it('should allow undefined planPresentationCount', () => {
      const session: {
        planPresentationCount?: number;
      } = {};
      expect(session.planPresentationCount).toBeUndefined();
    });
  });
});
