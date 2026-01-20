import { describe, it, expect, beforeEach } from 'vitest';
import { markFfAborted, isFfAborted, clearFfAborted, resetFfAborted } from '../../ff-abort-tracker.js';

describe('ff-abort-tracker', () => {
  beforeEach(() => {
    resetFfAborted();
  });

  describe('markFfAborted', () => {
    it('should mark a conversation as FF aborted', () => {
      expect(isFfAborted('conv_123')).toBe(false);
      markFfAborted('conv_123');
      expect(isFfAborted('conv_123')).toBe(true);
    });

    it('should handle multiple conversations independently', () => {
      markFfAborted('conv_1');
      markFfAborted('conv_2');

      expect(isFfAborted('conv_1')).toBe(true);
      expect(isFfAborted('conv_2')).toBe(true);
      expect(isFfAborted('conv_3')).toBe(false);
    });
  });

  describe('isFfAborted', () => {
    it('should return false for non-aborted conversations', () => {
      expect(isFfAborted('unknown')).toBe(false);
    });

    it('should return true for aborted conversations', () => {
      markFfAborted('aborted_conv');
      expect(isFfAborted('aborted_conv')).toBe(true);
    });
  });

  describe('clearFfAborted', () => {
    it('should clear FF aborted status', () => {
      markFfAborted('conv_123');
      expect(isFfAborted('conv_123')).toBe(true);

      clearFfAborted('conv_123');
      expect(isFfAborted('conv_123')).toBe(false);
    });

    it('should not affect other conversations', () => {
      markFfAborted('conv_1');
      markFfAborted('conv_2');

      clearFfAborted('conv_1');

      expect(isFfAborted('conv_1')).toBe(false);
      expect(isFfAborted('conv_2')).toBe(true);
    });
  });

  describe('FF sync stop flow', () => {
    it('should allow stopping sync mid-progress', () => {
      const conversationKey = 'C123_thread456';

      // Simulate sync starting (clears any previous abort)
      clearFfAborted(conversationKey);
      expect(isFfAborted(conversationKey)).toBe(false);

      // Simulate user clicking Stop FF button
      markFfAborted(conversationKey);

      // Sync loop checks abort flag
      const shouldStop = isFfAborted(conversationKey);
      expect(shouldStop).toBe(true);
    });

    it('should allow resuming after stop', () => {
      const conversationKey = 'C123_thread456';

      // First sync gets stopped
      markFfAborted(conversationKey);
      expect(isFfAborted(conversationKey)).toBe(true);

      // User runs /ff again (clears abort flag)
      clearFfAborted(conversationKey);
      expect(isFfAborted(conversationKey)).toBe(false);

      // New sync should proceed without stopping
      const shouldStop = isFfAborted(conversationKey);
      expect(shouldStop).toBe(false);
    });

    it('should handle channel vs thread conversations independently', () => {
      const channelKey = 'C123';
      const threadKey = 'C123_thread456';

      // Stop FF in thread
      markFfAborted(threadKey);

      // Channel sync should not be affected
      expect(isFfAborted(channelKey)).toBe(false);
      expect(isFfAborted(threadKey)).toBe(true);
    });
  });
});
