import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionFilePath,
  sessionFileExists,
  getFileSize,
  readNewMessages,
  extractTextContent,
  SessionFileMessage,
} from '../../session-reader.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    promises: {
      stat: vi.fn(),
      open: vi.fn(),
    },
  };
});

// Mock os module
vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/testuser'),
  };
});

describe('session-reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSessionFilePath', () => {
    it('should generate correct path for session file', () => {
      const sessionId = 'abc-123-def';
      const workingDir = '/Users/test/project';

      const result = getSessionFilePath(sessionId, workingDir);

      expect(result).toBe('/home/testuser/.claude/projects/-Users-test-project/abc-123-def.jsonl');
    });

    it('should handle root directory', () => {
      const sessionId = 'abc-123';
      const workingDir = '/';

      const result = getSessionFilePath(sessionId, workingDir);

      expect(result).toBe('/home/testuser/.claude/projects/-/abc-123.jsonl');
    });

    it('should handle nested paths', () => {
      const sessionId = 'session-id';
      const workingDir = '/home/user/deep/nested/path';

      const result = getSessionFilePath(sessionId, workingDir);

      expect(result).toBe('/home/testuser/.claude/projects/-home-user-deep-nested-path/session-id.jsonl');
    });
  });

  describe('sessionFileExists', () => {
    it('should return true when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = sessionFileExists('session-123', '/test/dir');

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/projects/-test-dir/session-123.jsonl'
      );
    });

    it('should return false when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = sessionFileExists('session-123', '/test/dir');

      expect(result).toBe(false);
    });
  });

  describe('getFileSize', () => {
    it('should return file size when file exists', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 12345 } as fs.Stats);

      const result = getFileSize('/some/path/file.jsonl');

      expect(result).toBe(12345);
    });

    it('should return 0 when file does not exist', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = getFileSize('/nonexistent/file.jsonl');

      expect(result).toBe(0);
    });
  });

  describe('readNewMessages', () => {
    it('should return empty array when file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await readNewMessages('/some/path.jsonl', 0);

      expect(result).toEqual({ messages: [], newOffset: 0 });
    });

    it('should return empty array when no new data', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: 100 } as fs.Stats);

      const result = await readNewMessages('/some/path.jsonl', 100);

      expect(result).toEqual({ messages: [], newOffset: 100 });
    });

    it('should parse user and assistant messages', async () => {
      const userMsg = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };
      const assistantMsg = {
        type: 'assistant',
        uuid: '456',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      };
      const content = JSON.stringify(userMsg) + '\n' + JSON.stringify(assistantMsg) + '\n';
      const buffer = Buffer.from(content);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: buffer.length } as fs.Stats);

      const mockFd = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValue(mockFd as any);

      const result = await readNewMessages('/some/path.jsonl', 0);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].type).toBe('user');
      expect(result.messages[1].type).toBe('assistant');
      // Offset should advance past the consumed lines
      expect(result.newOffset).toBeGreaterThan(0);
    });

    it('should filter out non-user/assistant message types', async () => {
      const progressMsg = { type: 'progress', data: {} };
      const queueMsg = { type: 'queue-operation', data: {} };
      const userMsg = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };
      const content = JSON.stringify(progressMsg) + '\n' + JSON.stringify(queueMsg) + '\n' + JSON.stringify(userMsg) + '\n';
      const buffer = Buffer.from(content);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: buffer.length } as fs.Stats);

      const mockFd = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValue(mockFd as any);

      const result = await readNewMessages('/some/path.jsonl', 0);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('user');
    });

    it('should handle incomplete JSON at end of file', async () => {
      const userMsg = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };
      // Incomplete JSON at end
      const content = JSON.stringify(userMsg) + '\n' + '{"type": "assistant", "incomplete';
      const completeLineLength = Buffer.byteLength(JSON.stringify(userMsg) + '\n', 'utf-8');
      const buffer = Buffer.from(content);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: buffer.length } as fs.Stats);

      const mockFd = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValue(mockFd as any);

      const result = await readNewMessages('/some/path.jsonl', 0);

      // Should only return the complete message
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('user');
      // Offset should only advance past complete lines
      expect(result.newOffset).toBe(completeLineLength);
    });

    it('should skip empty lines', async () => {
      const userMsg = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };
      const content = '\n\n' + JSON.stringify(userMsg) + '\n\n';
      const buffer = Buffer.from(content);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: buffer.length } as fs.Stats);

      const mockFd = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValue(mockFd as any);

      const result = await readNewMessages('/some/path.jsonl', 0);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('user');
    });

    it('should filter out messages without content', async () => {
      const userMsgWithContent = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };
      const userMsgWithoutContent = {
        type: 'user',
        uuid: '456',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'user' },  // No content
      };
      const content = JSON.stringify(userMsgWithContent) + '\n' + JSON.stringify(userMsgWithoutContent) + '\n';
      const buffer = Buffer.from(content);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: buffer.length } as fs.Stats);

      const mockFd = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValue(mockFd as any);

      const result = await readNewMessages('/some/path.jsonl', 0);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].uuid).toBe('123');
    });
  });

  describe('extractTextContent', () => {
    it('should extract text from text blocks', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('Hello\nWorld');
    });

    it('should include tool_use blocks with tool name', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read the file' },
            { type: 'tool_use', name: 'Read', input: { path: '/test.txt' } },
          ],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('Let me read the file\n[Tool: Read]');
    });

    it('should skip thinking blocks', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Internal thoughts...' },
            { type: 'text', text: 'Here is my response' },
          ],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('Here is my response');
      expect(result).not.toContain('Internal thoughts');
    });

    it('should skip tool_result blocks', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'File contents here...' },
            { type: 'text', text: 'Please analyze this' },
          ],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('Please analyze this');
      expect(result).not.toContain('File contents');
    });

    it('should return empty string for message without content', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
      };

      const result = extractTextContent(msg);

      expect(result).toBe('');
    });

    it('should return empty string for empty content array', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('');
    });

    it('should handle tool_use without name', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', input: { path: '/test.txt' } },
          ],
        },
      };

      const result = extractTextContent(msg);

      expect(result).toBe('');
    });
  });
});
