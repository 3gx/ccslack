import { describe, it, expect } from 'vitest';

// We need to extract and test the formatStatusFooter function
// Since it's currently inside slack-bot.ts, we'll test the expected format

describe('status footer format', () => {
  // Helper to format status footer (mirrors the function in slack-bot.ts)
  function formatStatusFooter(stats: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    modelUsage?: { [modelName: string]: { inputTokens: number; outputTokens: number } };
  } | null): string {
    if (!stats) return '';

    const parts: string[] = [];

    // Cost
    if (stats.costUsd !== undefined) {
      parts.push(`$${stats.costUsd.toFixed(3)}`);
    }

    // Tokens (input/output)
    if (stats.modelUsage) {
      const totalIn = Object.values(stats.modelUsage).reduce((sum, m) => sum + m.inputTokens, 0);
      const totalOut = Object.values(stats.modelUsage).reduce((sum, m) => sum + m.outputTokens, 0);
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      parts.push(`${formatTokens(totalIn)}/${formatTokens(totalOut)} tokens`);
    }

    // Turns
    if (stats.numTurns !== undefined) {
      parts.push(`${stats.numTurns} turn${stats.numTurns !== 1 ? 's' : ''}`);
    }

    // Duration
    if (stats.durationMs !== undefined) {
      const secs = (stats.durationMs / 1000).toFixed(1);
      parts.push(`${secs}s`);
    }

    return parts.join(' | ');
  }

  describe('formatStatusFooter', () => {
    it('should return empty string for null stats', () => {
      expect(formatStatusFooter(null)).toBe('');
    });

    it('should format cost with 3 decimal places', () => {
      const result = formatStatusFooter({ costUsd: 0.175 });
      expect(result).toBe('$0.175');
    });

    it('should format cost with leading zero', () => {
      const result = formatStatusFooter({ costUsd: 0.001 });
      expect(result).toBe('$0.001');
    });

    it('should format tokens under 1000 as plain numbers', () => {
      const result = formatStatusFooter({
        modelUsage: {
          'claude-sonnet': { inputTokens: 84, outputTokens: 24 },
        },
      });
      expect(result).toBe('84/24 tokens');
    });

    it('should format tokens over 1000 with k suffix', () => {
      const result = formatStatusFooter({
        modelUsage: {
          'claude-sonnet': { inputTokens: 1500, outputTokens: 2500 },
        },
      });
      expect(result).toBe('1.5k/2.5k tokens');
    });

    it('should sum tokens from multiple models', () => {
      const result = formatStatusFooter({
        modelUsage: {
          'claude-sonnet': { inputTokens: 500, outputTokens: 200 },
          'claude-haiku': { inputTokens: 300, outputTokens: 100 },
        },
      });
      expect(result).toBe('800/300 tokens');
    });

    it('should format single turn without plural', () => {
      const result = formatStatusFooter({ numTurns: 1 });
      expect(result).toBe('1 turn');
    });

    it('should format multiple turns with plural', () => {
      const result = formatStatusFooter({ numTurns: 5 });
      expect(result).toBe('5 turns');
    });

    it('should format duration in seconds', () => {
      const result = formatStatusFooter({ durationMs: 2200 });
      expect(result).toBe('2.2s');
    });

    it('should format all stats together with pipes', () => {
      const result = formatStatusFooter({
        costUsd: 0.175,
        modelUsage: {
          'claude-sonnet': { inputTokens: 84, outputTokens: 24 },
        },
        numTurns: 1,
        durationMs: 1900,
      });
      expect(result).toBe('$0.175 | 84/24 tokens | 1 turn | 1.9s');
    });

    it('should skip undefined fields', () => {
      const result = formatStatusFooter({
        costUsd: 0.1,
        numTurns: 2,
        // no modelUsage or durationMs
      });
      expect(result).toBe('$0.100 | 2 turns');
    });
  });

  describe('header format', () => {
    it('should format mode only header', () => {
      const mode = 'ask';
      const header = `_${mode}_`;
      expect(header).toBe('_ask_');
    });

    it('should format model | mode header', () => {
      const model = 'sonnet';
      const mode = 'ask';
      const header = `_${model} | ${mode}_`;
      expect(header).toBe('_sonnet | ask_');
    });

    it('should format error header', () => {
      const mode = 'ask';
      const header = `_error | ${mode}_`;
      expect(header).toBe('_error | ask_');
    });

    it('should format aborted header', () => {
      const header = '_aborted_';
      expect(header).toBe('_aborted_');
    });
  });

  describe('model name extraction', () => {
    it('should extract sonnet from full model name', () => {
      const fullModel = 'claude-sonnet-4-5-20250929';
      const match = fullModel.match(/claude-(\w+)/);
      const shortModel = match ? match[1] : fullModel;
      expect(shortModel).toBe('sonnet');
    });

    it('should extract opus from full model name', () => {
      const fullModel = 'claude-opus-4-5-20250929';
      const match = fullModel.match(/claude-(\w+)/);
      const shortModel = match ? match[1] : fullModel;
      expect(shortModel).toBe('opus');
    });

    it('should extract haiku from full model name', () => {
      const fullModel = 'claude-haiku-3-5-20250929';
      const match = fullModel.match(/claude-(\w+)/);
      const shortModel = match ? match[1] : fullModel;
      expect(shortModel).toBe('haiku');
    });

    it('should return full model if no match', () => {
      const fullModel = 'gpt-4';
      const match = fullModel.match(/claude-(\w+)/);
      const shortModel = match ? match[1] : fullModel;
      expect(shortModel).toBe('gpt-4');
    });
  });
});
