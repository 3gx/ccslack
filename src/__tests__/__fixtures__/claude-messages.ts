import { vi } from 'vitest';

/**
 * Test fixtures for Claude SDK message types
 */

export const mockSystemInit = {
  type: 'system' as const,
  subtype: 'init' as const,
  session_id: 'session-abc123',
};

export const mockAssistantText = {
  type: 'assistant' as const,
  content: 'Here is my analysis of the code...',
};

export const mockAssistantContentBlocks = {
  type: 'assistant' as const,
  content: [
    { type: 'text', text: 'Let me help you with that.' },
    { type: 'text', text: ' Here are my findings.' },
  ],
};

export const mockResult = {
  type: 'result' as const,
  result: 'Final complete response from Claude',
};

export const mockToolUse = {
  type: 'assistant' as const,
  content: [{
    type: 'tool_use',
    id: 'tool_123',
    name: 'Read',
    input: {
      file_path: '/test/file.txt',
    },
  }],
};

/**
 * Create a mock async generator that yields Claude messages
 */
export function createMockClaudeStream(messages?: any[]) {
  const defaultMessages = [
    mockSystemInit,
    mockAssistantText,
    mockResult,
  ];

  const messagesToYield = messages || defaultMessages;

  return async function* () {
    for (const msg of messagesToYield) {
      yield msg;
    }
  };
}

/**
 * Create a mock query function for the Claude SDK
 */
export function createMockQueryFn(messages?: any[]) {
  return vi.fn(createMockClaudeStream(messages));
}
