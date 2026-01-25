import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractPlanFilePathFromMessage, SessionFileMessage } from '../../session-reader';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

/**
 * Session Plan File Extraction Test
 *
 * This test verifies that plan file paths can be reliably extracted from
 * session JSONL files - a critical requirement for /resume command.
 *
 * The /resume command needs to sync the plan file path from the resumed
 * session so that /show-plan works correctly.
 *
 * This test:
 * 1. Creates a session in plan mode
 * 2. Has Claude write a plan to ~/.claude/plans/
 * 3. Extracts plan file path using extractPlanFilePathFromMessage()
 * 4. Verifies the extracted path matches the actual file written
 *
 * This catches SDK behavior changes that would break plan file extraction.
 */
describe.skipIf(SKIP_LIVE)('Session Plan File Extraction', { timeout: 180000 }, () => {
  let testSessionId: string | null = null;
  let extractedPlanPath: string | null = null;
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
    // Cleanup: delete plan file if created
    if (extractedPlanPath && fs.existsSync(extractedPlanPath)) {
      fs.unlinkSync(extractedPlanPath);
      console.log(`Cleaned up plan file: ${extractedPlanPath}`);
    }
  });

  it('creates session with plan file and extracts path from JSONL', async () => {
    // Create a session in plan mode that writes a plan file
    const q = query({
      prompt: 'Write a brief 1-sentence plan to a plan file then call ExitPlanMode. Keep it minimal.',
      options: {
        permissionMode: 'plan',
        maxTurns: 5,
      },
    });

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        testSessionId = (msg as any).session_id;
        console.log(`Created session: ${testSessionId}`);
      }
    }

    expect(testSessionId).not.toBeNull();

    // Read session file
    const filePath = getSessionFilePath(testSessionId!);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    console.log(`Session file has ${lines.length} lines`);

    // Extract plan file path from assistant messages using the same function
    // that findSessionFile() will use
    let lastPlanPath: string | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SessionFileMessage;
        if (parsed.type === 'assistant') {
          const planPath = extractPlanFilePathFromMessage(parsed);
          if (planPath) {
            lastPlanPath = planPath;
            console.log(`Found plan file path: ${planPath}`);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Verify we found a plan file path
    expect(lastPlanPath).not.toBeNull();
    console.log(`Extracted plan file path: ${lastPlanPath}`);

    // Verify path format is correct
    expect(lastPlanPath).toContain('.claude/plans/');
    expect(lastPlanPath).toMatch(/\.md$/);

    extractedPlanPath = lastPlanPath;
  });

  it('extracted plan file path matches actual file on disk', async () => {
    expect(extractedPlanPath).not.toBeNull();

    // Verify the plan file exists
    const exists = fs.existsSync(extractedPlanPath!);
    console.log(`Plan file exists at ${extractedPlanPath}: ${exists}`);
    expect(exists).toBe(true);

    // Verify it's a valid file (not empty)
    const stats = fs.statSync(extractedPlanPath!);
    console.log(`Plan file size: ${stats.size} bytes`);
    expect(stats.size).toBeGreaterThan(0);

    // Read and display content for verification
    const planContent = fs.readFileSync(extractedPlanPath!, 'utf-8');
    console.log(`Plan file content preview: ${planContent.substring(0, 200)}...`);
  });

  it('extractPlanFilePathFromMessage returns LAST plan path when multiple exist', async () => {
    // This test verifies that if Claude writes multiple plans, we get the last one
    // We simulate this by parsing a session with multiple Write tool calls

    const mockSession = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/Users/test/.claude/plans/first-plan.md' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/Users/test/.claude/plans/second-plan.md' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/Users/test/.claude/plans/third-plan.md' },
            },
          ],
        },
      },
    ];

    let lastPlanPath: string | null = null;
    for (const msg of mockSession) {
      const planPath = extractPlanFilePathFromMessage(msg as SessionFileMessage);
      if (planPath) {
        lastPlanPath = planPath;
      }
    }

    // Should return the LAST plan path
    expect(lastPlanPath).toBe('/Users/test/.claude/plans/third-plan.md');
    console.log('✓ Correctly extracts LAST plan path when multiple exist');
  });

  it('extractPlanFilePathFromMessage returns null for non-plan paths', async () => {
    const nonPlanMessages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/Users/test/src/index.ts' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/Users/test/README.md' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Hello world',
            },
          ],
        },
      },
    ];

    for (const msg of nonPlanMessages) {
      const planPath = extractPlanFilePathFromMessage(msg as SessionFileMessage);
      expect(planPath).toBeNull();
    }

    console.log('✓ Correctly returns null for non-plan file paths');
  });

  it('extractPlanFilePathFromMessage handles path property (not just file_path)', async () => {
    // Some tools use `path` instead of `file_path`
    const msgWithPath = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Glob',
            input: { path: '/Users/test/.claude/plans/glob-plan.md' },
          },
        ],
      },
    };

    const planPath = extractPlanFilePathFromMessage(msgWithPath as SessionFileMessage);
    expect(planPath).toBe('/Users/test/.claude/plans/glob-plan.md');
    console.log('✓ Correctly handles `path` property (not just `file_path`)');
  });
});
