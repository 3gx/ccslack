import { describe, it, expect, beforeEach } from 'vitest';
import { markAborted, isAborted, clearAborted, reset } from '../../abort-tracker.js';

describe('abort-tracker', () => {
  beforeEach(() => {
    reset();
  });

  describe('markAborted', () => {
    it('should mark a conversation as aborted', () => {
      expect(isAborted('conv_123')).toBe(false);
      markAborted('conv_123');
      expect(isAborted('conv_123')).toBe(true);
    });

    it('should handle multiple conversations independently', () => {
      markAborted('conv_1');
      markAborted('conv_2');

      expect(isAborted('conv_1')).toBe(true);
      expect(isAborted('conv_2')).toBe(true);
      expect(isAborted('conv_3')).toBe(false);
    });
  });

  describe('isAborted', () => {
    it('should return false for non-aborted conversations', () => {
      expect(isAborted('unknown')).toBe(false);
    });

    it('should return true for aborted conversations', () => {
      markAborted('aborted_conv');
      expect(isAborted('aborted_conv')).toBe(true);
    });
  });

  describe('clearAborted', () => {
    it('should clear aborted status', () => {
      markAborted('conv_123');
      expect(isAborted('conv_123')).toBe(true);

      clearAborted('conv_123');
      expect(isAborted('conv_123')).toBe(false);
    });

    it('should not affect other conversations', () => {
      markAborted('conv_1');
      markAborted('conv_2');

      clearAborted('conv_1');

      expect(isAborted('conv_1')).toBe(false);
      expect(isAborted('conv_2')).toBe(true);
    });
  });

  describe('race condition prevention', () => {
    it('should prevent status deletion when aborted', () => {
      const conversationKey = 'C123_thread456';

      // Simulate abort button click - markAborted is called FIRST (synchronous)
      markAborted(conversationKey);

      // Simulate main flow checking if it should delete status message
      // This should return false because we already marked as aborted
      const shouldDeleteStatus = !isAborted(conversationKey);

      expect(shouldDeleteStatus).toBe(false);
    });

    it('should allow status deletion when not aborted', () => {
      const conversationKey = 'C123_thread456';

      // Main flow completes normally, checks if aborted
      const shouldDeleteStatus = !isAborted(conversationKey);

      expect(shouldDeleteStatus).toBe(true);
    });

    it('should allow new requests after cleanup', () => {
      const conversationKey = 'C123_thread456';

      // First request gets aborted
      markAborted(conversationKey);
      expect(isAborted(conversationKey)).toBe(true);

      // Cleanup in finally block
      clearAborted(conversationKey);
      expect(isAborted(conversationKey)).toBe(false);

      // New request should work normally
      const shouldDeleteStatus = !isAborted(conversationKey);
      expect(shouldDeleteStatus).toBe(true);
    });
  });
});
