import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

/**
 * Session cwd Immutability Test
 *
 * This test verifies that the `cwd` field in user messages is immutable
 * throughout a session - a critical assumption for /resume command.
 *
 * The /resume command extracts working directory from the first user
 * message's cwd field. If SDK changes this behavior (e.g., cwd starts
 * reflecting actual current directory after `cd` commands), /resume
 * would break.
 *
 * This test catches SDK behavior changes early.
 */
describe.skipIf(SKIP_LIVE)('Session cwd Immutability', { timeout: 120000 }, () => {
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

  it('user message has cwd field equal to process.cwd()', async () => {
    // Create a session with a simple query
    const q = query({
      prompt: 'Say exactly: "test"',
      options: { maxTurns: 1 },
    });

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        testSessionId = (msg as any).session_id;
      }
    }

    expect(testSessionId).not.toBeNull();
    console.log(`Created session: ${testSessionId}`);

    // Read session file and find first user message
    const filePath = getSessionFilePath(testSessionId!);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const firstUserMessage = lines
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find(e => e && e.type === 'user');

    expect(firstUserMessage).toBeDefined();
    expect(firstUserMessage.cwd).toBeDefined();
    expect(firstUserMessage.cwd).toBe(workingDir);

    console.log(`✓ User message cwd matches process.cwd(): ${workingDir}`);
  });

  it('all user messages in session have identical cwd field', async () => {
    expect(testSessionId).not.toBeNull();

    // Send second query to same session to create more user messages
    const q2 = query({
      prompt: 'Say exactly: "second"',
      options: {
        maxTurns: 1,
        sessionId: testSessionId!,
      },
    });

    for await (const _msg of q2) {
      // Just consume the stream
    }

    // Read session file and extract all user messages
    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const userMessages = lines
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(e => e && e.type === 'user' && e.cwd);

    console.log(`Found ${userMessages.length} user messages with cwd field`);

    // Must have at least 1 user message
    expect(userMessages.length).toBeGreaterThanOrEqual(1);

    // Extract all cwd values
    const cwdValues = userMessages.map(m => m.cwd);
    console.log('cwd values:', cwdValues);

    // All cwd values must be identical
    const uniqueCwdValues = [...new Set(cwdValues)];
    expect(uniqueCwdValues.length).toBe(1);
    expect(uniqueCwdValues[0]).toBe(workingDir);

    console.log(`✓ All ${userMessages.length} user messages have identical cwd: ${workingDir}`);
  });

  it('cwd field is present on every user message entry', async () => {
    expect(testSessionId).not.toBeNull();

    const filePath = getSessionFilePath(testSessionId!);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const allUserMessages = lines
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(e => e && e.type === 'user');

    const userMessagesWithCwd = allUserMessages.filter(m => m.cwd);

    console.log(`Total user messages: ${allUserMessages.length}`);
    console.log(`User messages with cwd: ${userMessagesWithCwd.length}`);

    // All user messages should have cwd field
    expect(userMessagesWithCwd.length).toBe(allUserMessages.length);

    console.log(`✓ All ${allUserMessages.length} user messages have cwd field`);
  });
});
