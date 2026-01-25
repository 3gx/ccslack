import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionFilePath,
  sessionFileExists,
  findSessionFile,
  getFileSize,
  readNewMessages,
  extractTextContent,
  findMessageIndexByUuid,
  buildActivityEntriesFromMessage,
  readLastUserMessageUuid,
  SessionFileMessage,
} from '../../session-reader.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
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

  describe('findSessionFile', () => {
    it('should return null when projects directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = findSessionFile('12345678-1234-1234-1234-123456789012');

      expect(result).toBeNull();
    });

    it('should return null when session file not found in any directory', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        // Projects dir exists, but session file doesn't
        return pathStr === '/home/testuser/.claude/projects';
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-tmp-project', isDirectory: () => true },
        { name: '-home-user', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);

      const result = findSessionFile('nonexistent-session-id');

      expect(result).toBeNull();
    });

    it('should find session file and extract cwd from first user message', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = {
        type: 'user',
        uuid: 'user-uuid',
        cwd: '/tmp/myproject',
        message: { role: 'user', content: 'Hello' },
      };

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-tmp-myproject/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-tmp-myproject', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(userMessage) + '\n');

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/tmp/myproject');
      expect(result?.filePath).toBe(`/home/testuser/.claude/projects/-tmp-myproject/${sessionId}.jsonl`);
    });

    it('should skip non-directory entries', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/correct/path', message: { role: 'user', content: 'Hello' } };

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-correct-path/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'some-file.txt', isDirectory: () => false },
        { name: '-correct-path', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(userMessage) + '\n');

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/correct/path');
    });

    it('should return null when JSONL has no user messages with cwd', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const assistantMessage = { type: 'assistant', uuid: 'asst-uuid', message: { role: 'assistant', content: [] } };

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-tmp-project/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-tmp-project', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(assistantMessage) + '\n');

      const result = findSessionFile(sessionId);

      expect(result).toBeNull();
    });

    it('should handle malformed JSONL lines gracefully', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/good/path', message: { role: 'user', content: 'Hello' } };
      const malformedContent = 'not valid json\n' + JSON.stringify(userMessage) + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-good-path/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-good-path', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(malformedContent);

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/good/path');
    });

    it('should return null when readdirSync throws', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = findSessionFile('12345678-1234-1234-1234-123456789012');

      expect(result).toBeNull();
    });

    it('should return null when readFileSync throws', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-tmp-project/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-tmp-project', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = findSessionFile(sessionId);

      expect(result).toBeNull();
    });

    it('should skip empty lines in JSONL', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/my/path', message: { role: 'user', content: 'Hello' } };
      const contentWithEmptyLines = '\n\n' + JSON.stringify(userMessage) + '\n\n';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-my-path/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-my-path', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(contentWithEmptyLines);

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/my/path');
    });

    it('should extract planFilePath when present in assistant message', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/my/project', message: { role: 'user', content: 'Hello' } };
      const assistantMessage = {
        type: 'assistant',
        uuid: 'asst-uuid',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/Users/test/.claude/plans/my-plan.md', content: '# Plan' },
          }],
        },
      };
      const content = JSON.stringify(userMessage) + '\n' + JSON.stringify(assistantMessage) + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-my-project/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-my-project', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/my/project');
      expect(result?.planFilePath).toBe('/Users/test/.claude/plans/my-plan.md');
    });

    it('should return last planFilePath when multiple plans exist', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/my/project', message: { role: 'user', content: 'Hello' } };
      const assistantMessage1 = {
        type: 'assistant',
        uuid: 'asst-uuid-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/Users/test/.claude/plans/first-plan.md', content: '# First' },
          }],
        },
      };
      const assistantMessage2 = {
        type: 'assistant',
        uuid: 'asst-uuid-2',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/Users/test/.claude/plans/second-plan.md', content: '# Second' },
          }],
        },
      };
      const content = [userMessage, assistantMessage1, assistantMessage2].map(m => JSON.stringify(m)).join('\n') + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-my-project/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-my-project', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.planFilePath).toBe('/Users/test/.claude/plans/second-plan.md');
    });

    it('should return null planFilePath when no plans in session', () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const userMessage = { type: 'user', uuid: 'user-uuid', cwd: '/my/project', message: { role: 'user', content: 'Hello' } };
      const assistantMessage = {
        type: 'assistant',
        uuid: 'asst-uuid',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
        },
      };
      const content = JSON.stringify(userMessage) + '\n' + JSON.stringify(assistantMessage) + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === '/home/testuser/.claude/projects') return true;
        if (pathStr === `/home/testuser/.claude/projects/-my-project/${sessionId}.jsonl`) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '-my-project', isDirectory: () => true },
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = findSessionFile(sessionId);

      expect(result).not.toBeNull();
      expect(result?.workingDir).toBe('/my/project');
      expect(result?.planFilePath).toBeNull();
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

    it('should extract plan from Write tool input', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/Users/x/.claude/plans/test.md',
              content: '# My Plan\n\nContent here',
            },
          }],
        },
      };
      expect(extractTextContent(msg)).toBe('# My Plan\n\nContent here');
    });

    it('should extract plan from ExitPlanMode input.plan', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'ExitPlanMode',
            input: { plan: '# Exit Plan\n\nDetails' },
          }],
        },
      };
      expect(extractTextContent(msg)).toBe('# Exit Plan\n\nDetails');
    });

    it('should extract plan from toolUseResult.content (Write result)', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: { role: 'user', content: [] },
        toolUseResult: {
          type: 'create',
          filePath: '/Users/x/.claude/plans/test.md',
          content: '# Created Plan',
        },
      };
      expect(extractTextContent(msg)).toBe('# Created Plan');
    });

    it('should extract plan from toolUseResult.file.content (Read result)', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: { role: 'user', content: [] },
        toolUseResult: {
          type: 'text',
          file: {
            filePath: '/Users/x/.claude/plans/test.md',
            content: '# Read Plan Content',
          },
        },
      };
      expect(extractTextContent(msg)).toBe('# Read Plan Content');
    });

    it('should NOT extract from non-plan files', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/Users/x/project/src/file.ts',
              content: 'const x = 1;',
            },
          }],
        },
      };
      expect(extractTextContent(msg)).toBe('[Tool: Write]');
    });

    it('should still extract regular text content', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        timestamp: '2024-01-01',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };
      expect(extractTextContent(msg)).toBe('Hello world');
    });
  });

  describe('findMessageIndexByUuid', () => {
    it('should return -1 when UUID not found', () => {
      const messages = [
        { uuid: 'uuid-1', type: 'user' },
        { uuid: 'uuid-2', type: 'assistant' },
      ] as SessionFileMessage[];

      const result = findMessageIndexByUuid(messages, 'uuid-not-found');

      expect(result).toBe(-1);
    });

    it('should return correct index when UUID found', () => {
      const messages = [
        { uuid: 'uuid-1', type: 'user' },
        { uuid: 'uuid-2', type: 'assistant' },
        { uuid: 'uuid-3', type: 'user' },
      ] as SessionFileMessage[];

      expect(findMessageIndexByUuid(messages, 'uuid-1')).toBe(0);
      expect(findMessageIndexByUuid(messages, 'uuid-2')).toBe(1);
      expect(findMessageIndexByUuid(messages, 'uuid-3')).toBe(2);
    });

    it('should return -1 for empty array', () => {
      const messages: SessionFileMessage[] = [];

      const result = findMessageIndexByUuid(messages, 'any-uuid');

      expect(result).toBe(-1);
    });
  });

  describe('readLastUserMessageUuid', () => {
    it('should return null when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = readLastUserMessageUuid('/nonexistent/file.jsonl');

      expect(result).toBeNull();
    });

    it('should return the last user message UUID', () => {
      const userMsg1 = { type: 'user', uuid: 'uuid-first', message: { role: 'user', content: 'Hello' } };
      const assistantMsg = { type: 'assistant', uuid: 'uuid-assistant', message: { role: 'assistant', content: [] } };
      const userMsg2 = { type: 'user', uuid: 'uuid-last', message: { role: 'user', content: 'World' } };
      const content = [userMsg1, assistantMsg, userMsg2].map(m => JSON.stringify(m)).join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      expect(result).toBe('uuid-last');
    });

    it('should return null when no user messages exist', () => {
      const assistantMsg = { type: 'assistant', uuid: 'uuid-assistant', message: { role: 'assistant', content: [] } };
      const progressMsg = { type: 'progress', uuid: 'uuid-progress' };
      const content = [assistantMsg, progressMsg].map(m => JSON.stringify(m)).join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      expect(result).toBeNull();
    });

    it('should skip lines with invalid JSON', () => {
      const userMsg = { type: 'user', uuid: 'uuid-valid', message: { role: 'user', content: 'Hello' } };
      const content = JSON.stringify(userMsg) + '\n' + 'invalid json line' + '\n' + '{ broken json';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      expect(result).toBe('uuid-valid');
    });

    it('should return null when file read fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = readLastUserMessageUuid('/protected/file.jsonl');

      expect(result).toBeNull();
    });

    it('should handle empty file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const result = readLastUserMessageUuid('/empty/file.jsonl');

      expect(result).toBeNull();
    });

    it('should handle file with only whitespace', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('   \n\n  \n');

      const result = readLastUserMessageUuid('/whitespace/file.jsonl');

      expect(result).toBeNull();
    });

    it('should return user UUID even when last line is non-user message', () => {
      const userMsg = { type: 'user', uuid: 'uuid-user', message: { role: 'user', content: 'Hello' } };
      const assistantMsg = { type: 'assistant', uuid: 'uuid-assistant', message: { role: 'assistant', content: [] } };
      const content = JSON.stringify(userMsg) + '\n' + JSON.stringify(assistantMsg);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      // Should find the user message even though assistant message is last
      expect(result).toBe('uuid-user');
    });

    it('should return user text UUID, not tool_result UUID when tools are used', () => {
      // This is the critical test case for the /ff import bug fix:
      // When Claude uses tools, tool_result messages have type: 'user' but should NOT
      // be returned - only actual user text input should be returned.
      const userTextMsg = {
        type: 'user',
        uuid: 'uuid-user-text',
        message: { role: 'user', content: [{ type: 'text', text: 'analyze this file' }] }
      };
      const toolResultMsg = {
        type: 'user',
        uuid: 'uuid-tool-result',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'file contents here' }] }
      };
      const assistantMsg = {
        type: 'assistant',
        uuid: 'uuid-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Analysis complete' }] }
      };
      const content = [userTextMsg, toolResultMsg, assistantMsg]
        .map(m => JSON.stringify(m))
        .join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      // Should return the user TEXT input UUID, NOT the tool_result UUID
      expect(result).toBe('uuid-user-text');
    });

    it('should return user text UUID when multiple tool_results follow', () => {
      // Multiple tool calls create multiple tool_result messages
      const userTextMsg = {
        type: 'user',
        uuid: 'uuid-user-text',
        message: { role: 'user', content: 'read these files' }  // string content
      };
      const toolResult1 = {
        type: 'user',
        uuid: 'uuid-tool-result-1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file1 content' }] }
      };
      const toolResult2 = {
        type: 'user',
        uuid: 'uuid-tool-result-2',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file2 content' }] }
      };
      const content = [userTextMsg, toolResult1, toolResult2]
        .map(m => JSON.stringify(m))
        .join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = readLastUserMessageUuid('/some/file.jsonl');

      // Should skip both tool_results and return the user text input
      expect(result).toBe('uuid-user-text');
    });
  });

  describe('buildActivityEntriesFromMessage', () => {
    it('should return empty array for user messages', () => {
      const msg: SessionFileMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toEqual([]);
    });

    it('should extract thinking block as activity entry', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('thinking');
      expect(result[0].thinkingContent).toBe('Let me think about this...');
      expect(result[0].thinkingTruncated).toBe('Let me think about this...');
      expect(result[0].timestamp).toBe(new Date('2024-01-01T12:00:00Z').getTime());
    });

    it('should truncate long thinking content in thinkingTruncated', () => {
      const longThinking = 'A'.repeat(600);  // 600 chars, should be truncated
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: longThinking }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].thinkingContent).toBe(longThinking);  // Full content preserved
      expect(result[0].thinkingTruncated).toHaveLength(503);  // 500 chars + '...'
      expect(result[0].thinkingTruncated?.endsWith('...')).toBe(true);
    });

    it('should extract tool_use block as tool_start entry', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { path: '/test.txt' } }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('tool_start');
      expect(result[0].tool).toBe('Read');
    });

    it('should extract text block as generating entry', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is my response with 30 chars' }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('generating');
      expect(result[0].generatingChars).toBe(33);  // 'Here is my response with 30 chars'.length
    });

    it('should extract multiple content blocks in order', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'test' } },
            { type: 'text', text: 'Found it!' },
          ],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('thinking');
      expect(result[1].type).toBe('tool_start');
      expect(result[1].tool).toBe('Grep');
      expect(result[2].type).toBe('generating');
    });

    it('should skip tool_result blocks', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_result', content: 'File contents...' },
            { type: 'text', text: 'Based on the file...' },
          ],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('generating');
    });

    it('should return empty array for message without content', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toEqual([]);
    });

    it('should return empty array for message with string content', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: 'Plain string content',  // This shouldn't happen for assistant but handle it
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toEqual([]);
    });

    it('should skip tool_use without name', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', input: { path: '/test.txt' } },  // No name
            { type: 'text', text: 'Response' },
          ],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('generating');
    });

    it('should skip text block without text', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text' },  // No text
            { type: 'thinking', thinking: 'Thinking...' },
          ],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('thinking');
    });

    it('should handle thinking block with empty thinking content', () => {
      const msg: SessionFileMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '' }],
        },
      };

      const result = buildActivityEntriesFromMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('thinking');
      expect(result[0].thinkingContent).toBe('');
      expect(result[0].thinkingTruncated).toBe('');
    });
  });
});
