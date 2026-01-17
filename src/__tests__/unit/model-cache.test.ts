import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before any imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

describe('model-cache', () => {
  // We need to reset module state between tests
  let getAvailableModels: typeof import('../../model-cache.js').getAvailableModels;
  let refreshModelCache: typeof import('../../model-cache.js').refreshModelCache;
  let isModelAvailable: typeof import('../../model-cache.js').isModelAvailable;
  let getModelInfo: typeof import('../../model-cache.js').getModelInfo;
  let getDefaultModel: typeof import('../../model-cache.js').getDefaultModel;

  const mockModels = [
    { value: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', description: 'Fast and capable' },
    { value: 'claude-opus-4', displayName: 'Claude Opus 4', description: 'Most capable' },
  ];

  const createMockQuery = (models = mockModels, shouldFail = false) => {
    return {
      supportedModels: vi.fn().mockImplementation(() => {
        if (shouldFail) {
          return Promise.reject(new Error('SDK error'));
        }
        return Promise.resolve(models);
      }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init' };
      },
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-mock after reset
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));

    // Re-import module to reset internal state
    const modelCache = await import('../../model-cache.js');
    getAvailableModels = modelCache.getAvailableModels;
    refreshModelCache = modelCache.refreshModelCache;
    isModelAvailable = modelCache.isModelAvailable;
    getModelInfo = modelCache.getModelInfo;
    getDefaultModel = modelCache.getDefaultModel;
  });

  describe('Cache TTL Logic', () => {
    it('getAvailableModels returns cached models when fresh', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      // First call - should fetch from SDK
      const result1 = await getAvailableModels();
      expect(result1).toEqual(mockModels);
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Second call - should return cached (no new SDK call)
      const result2 = await getAvailableModels();
      expect(result2).toEqual(mockModels);
      expect(mockQuery).toHaveBeenCalledTimes(1); // Still 1, no new call
    });

    it('getAvailableModels refreshes when cache is stale', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      // Use fake timers
      vi.useFakeTimers();

      // First call
      await getAvailableModels();
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Advance time past TTL (1 hour + 1ms)
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      // Second call - should refresh
      await getAvailableModels();
      expect(mockQuery).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('getAvailableModels refreshes on first call with empty cache', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      // First call with empty cache should trigger refresh
      const result = await getAvailableModels();
      expect(result).toEqual(mockModels);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mock.supportedModels).toHaveBeenCalled();
    });
  });

  describe('SDK Integration', () => {
    it('refreshModelCache creates query with correct options', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      await refreshModelCache();

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: '',
        options: {
          maxTurns: 1,
        },
      });
    });

    it('refreshModelCache calls supportedModels on query', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      await refreshModelCache();

      expect(mock.supportedModels).toHaveBeenCalled();
    });

    it('refreshModelCache updates cache and timestamp', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await refreshModelCache();

      // Should return the models
      expect(result).toEqual(mockModels);

      // Subsequent getAvailableModels should return cached (no new call)
      await getAvailableModels();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('refreshModelCache calls interrupt after getting models', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      await refreshModelCache();

      expect(mock.interrupt).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('refreshModelCache uses fallback when SDK fails and cache empty', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery([], true); // Will fail
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await refreshModelCache();

      // Should return fallback models
      expect(result).toHaveLength(3);
      expect(result[0].value).toBe('claude-sonnet-4-5-20250929');
      expect(result[1].value).toBe('claude-haiku-4-5-20251001');
      expect(result[2].value).toBe('claude-opus-4-5-20251101');
    });

    it('refreshModelCache keeps existing cache when SDK fails', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');

      // First call succeeds
      const successMock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(successMock as any);
      await refreshModelCache();

      // Second call fails
      const failMock = createMockQuery([], true);
      vi.mocked(mockQuery).mockReturnValue(failMock as any);

      vi.useFakeTimers();
      vi.advanceTimersByTime(60 * 60 * 1000 + 1); // Past TTL

      const result = await refreshModelCache();
      vi.useRealTimers();

      // Should keep the original cache
      expect(result).toEqual(mockModels);
    });

    it('interrupt errors are silently ignored', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      mock.interrupt = vi.fn().mockRejectedValue(new Error('Interrupt failed'));
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      // Should not throw
      await expect(refreshModelCache()).resolves.toEqual(mockModels);
    });
  });

  describe('Model Lookup', () => {
    it('isModelAvailable returns true for existing model', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await isModelAvailable('claude-sonnet-4');
      expect(result).toBe(true);
    });

    it('isModelAvailable returns false for non-existing model', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await isModelAvailable('non-existent-model');
      expect(result).toBe(false);
    });

    it('getModelInfo returns model info for existing model', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await getModelInfo('claude-opus-4');
      expect(result).toEqual(mockModels[1]);
    });

    it('getModelInfo returns undefined for unknown model', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await getModelInfo('unknown-model');
      expect(result).toBeUndefined();
    });

    it('getDefaultModel returns first model', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery();
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await getDefaultModel();
      expect(result).toEqual(mockModels[0]);
    });

    it('getDefaultModel returns undefined for empty list', async () => {
      const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mock = createMockQuery([]);
      vi.mocked(mockQuery).mockReturnValue(mock as any);

      const result = await getDefaultModel();
      expect(result).toBeUndefined();
    });
  });
});
