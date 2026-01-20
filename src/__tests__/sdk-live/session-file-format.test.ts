import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

/**
 * JSONL Session File Format Tests
 *
 * These tests verify the session file format hasn't changed in SDK upgrades.
 * The /continue terminal watcher depends on this format.
 *
 * If these tests fail after an SDK upgrade, update:
 * - src/session-reader.ts (SessionFileMessage interface)
 * - src/terminal-watcher.ts (message filtering/extraction)
 */
describe.skipIf(SKIP_LIVE)('Session File Format', { timeout: 120000 }, () => {
  let testSessionId: string | null = null;
  const workingDir = process.cwd();

  function getSessionFilePath(sessionId: string): string {
    const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
    return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
  }

  afterAll(() => {
    // Cleanup: delete test session file
    if (testSessionId) {
      const filePath = getSessionFilePath(testSessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up test session: ${testSessionId}`);
      }
    }
  });

  it('session file exists after query and contains expected structure', async () => {
    // Create a session with a simple query
    const q = query({
      prompt: 'Say exactly: "test message"',
      options: { maxTurns: 1 },
    });

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        testSessionId = (msg as any).session_id;
      }
    }

    expect(testSessionId).not.toBeNull();

    // Verify session file exists
    const filePath = getSessionFilePath(testSessionId!);
    expect(fs.existsSync(filePath)).toBe(true);

    // Read and parse JSONL
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    expect(lines.length).toBeGreaterThan(0);

    // Parse each line and collect types
    const entries: any[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line);
      entries.push(parsed);
    }

    console.log(`Session file has ${entries.length} entries`);
    console.log(`Types found: ${[...new Set(entries.map(e => e.type))].join(', ')}`);

    // Verify expected entry types exist
    const types = entries.map(e => e.type);
    expect(types).toContain('user');
    expect(types).toContain('assistant');
  });

  it('user message has required fields for terminal watcher', async () => {
    expect(testSessionId).not.toBeNull();
    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const userEntry = lines
      .map(l => JSON.parse(l))
      .find(e => e.type === 'user' && e.message?.content);

    expect(userEntry).toBeDefined();

    // Required fields for terminal watcher
    expect(userEntry).toHaveProperty('type', 'user');
    expect(userEntry).toHaveProperty('uuid');
    expect(userEntry).toHaveProperty('timestamp');
    expect(userEntry).toHaveProperty('sessionId');
    expect(userEntry).toHaveProperty('message');
    expect(userEntry.message).toHaveProperty('role', 'user');
    expect(userEntry.message).toHaveProperty('content');
    expect(Array.isArray(userEntry.message.content)).toBe(true);

    // Content block structure
    const textBlock = userEntry.message.content.find((c: any) => c.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock).toHaveProperty('text');
    expect(typeof textBlock.text).toBe('string');

    console.log('User entry structure verified:', {
      type: userEntry.type,
      uuid: userEntry.uuid?.substring(0, 8) + '...',
      hasMessage: !!userEntry.message,
      contentTypes: userEntry.message.content.map((c: any) => c.type),
    });
  });

  it('assistant message has required fields for terminal watcher', async () => {
    expect(testSessionId).not.toBeNull();
    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const assistantEntry = lines
      .map(l => JSON.parse(l))
      .find(e => e.type === 'assistant' && e.message?.content);

    expect(assistantEntry).toBeDefined();

    // Required fields for terminal watcher
    expect(assistantEntry).toHaveProperty('type', 'assistant');
    expect(assistantEntry).toHaveProperty('uuid');
    expect(assistantEntry).toHaveProperty('timestamp');
    expect(assistantEntry).toHaveProperty('sessionId');
    expect(assistantEntry).toHaveProperty('message');
    expect(assistantEntry.message).toHaveProperty('role', 'assistant');
    expect(assistantEntry.message).toHaveProperty('content');
    expect(Array.isArray(assistantEntry.message.content)).toBe(true);

    // Content block structure - assistant should have text
    const textBlock = assistantEntry.message.content.find((c: any) => c.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock).toHaveProperty('text');
    expect(typeof textBlock.text).toBe('string');

    console.log('Assistant entry structure verified:', {
      type: assistantEntry.type,
      uuid: assistantEntry.uuid?.substring(0, 8) + '...',
      hasMessage: !!assistantEntry.message,
      contentTypes: assistantEntry.message.content.map((c: any) => c.type),
    });
  });

  it('timestamps are ISO 8601 format', async () => {
    expect(testSessionId).not.toBeNull();
    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const entries = lines.map(l => JSON.parse(l));
    const withTimestamp = entries.filter(e => e.timestamp);

    expect(withTimestamp.length).toBeGreaterThan(0);

    for (const entry of withTimestamp) {
      // Should parse as valid date
      const date = new Date(entry.timestamp);
      expect(date.toString()).not.toBe('Invalid Date');

      // Should be ISO 8601 format (ends with Z or timezone)
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }

    console.log(`Verified ${withTimestamp.length} timestamps are ISO 8601`);
  });

  it('uuid fields are valid UUID v4 format', async () => {
    expect(testSessionId).not.toBeNull();
    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const entries = lines.map(l => JSON.parse(l));
    const withUuid = entries.filter(e => e.uuid);

    expect(withUuid.length).toBeGreaterThan(0);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const entry of withUuid) {
      expect(entry.uuid).toMatch(uuidRegex);
    }

    console.log(`Verified ${withUuid.length} UUIDs are valid format`);
  });
});
