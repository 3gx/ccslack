/**
 * SDK Live Test: Synthetic fork (null prompt)
 *
 * Verifies that forking with a synthetic message (single space, isSynthetic: true)
 * creates a valid session that can be resumed without API errors.
 *
 * This matches CLI behavior: `claude --resume <id> --fork-session`
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('SDK fork with synthetic message (null prompt)', () => {
  function getSessionFile(sessionId: string): string {
    // Project path format: -Users-egx-ai-ccslack (leading dash, slashes replaced with dashes)
    const cwd = process.cwd();
    const projectPath = cwd.replace(/\//g, '-');
    return path.join(os.homedir(), '.claude', 'projects', projectPath, `${sessionId}.jsonl`);
  }

  it('should create fork without empty text blocks and resume successfully', async () => {
    // Step 1: Create a source session
    console.log('Step 1: Creating source session...');
    const sourceQuery = query({
      prompt: 'Say exactly: SOURCE_SESSION_CREATED',
      options: {
        permissionMode: 'bypassPermissions',
        outputFormat: 'stream-json',
      },
    });

    let sourceSessionId: string | null = null;
    let sourceMessageId: string | null = null;

    for await (const event of sourceQuery) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        sourceSessionId = (event as any).session_id;
      }
      if (event.type === 'assistant' && (event as any).uuid) {
        sourceMessageId = (event as any).uuid;
      }
    }

    expect(sourceSessionId).toBeTruthy();
    expect(sourceMessageId).toBeTruthy();
    console.log('Source session:', sourceSessionId);

    // Step 2: Fork using synthetic message (like null prompt in startClaudeQuery)
    console.log('Step 2: Forking with synthetic message...');

    async function* syntheticStream() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: '.' }] },
        parent_tool_use_id: null,
        session_id: sourceSessionId!,
        isSynthetic: true,
      };
    }

    const forkQuery = query({
      prompt: syntheticStream(),
      options: {
        resume: sourceSessionId!,
        forkSession: true,
        permissionMode: 'bypassPermissions',
        outputFormat: 'stream-json',
      },
    });

    let forkedSessionId: string | null = null;

    for await (const event of forkQuery) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        forkedSessionId = (event as any).session_id;
      }
    }

    expect(forkedSessionId).toBeTruthy();
    expect(forkedSessionId).not.toBe(sourceSessionId);
    console.log('Forked session:', forkedSessionId);

    // Step 3: Verify no empty text blocks in forked session
    console.log('Step 3: Checking for empty text blocks...');
    const sessionFile = getSessionFile(forkedSessionId!);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const content = fs.readFileSync(sessionFile, 'utf-8');
    const hasEmptyText = content.includes('"text":""');
    expect(hasEmptyText).toBe(false);
    console.log('No empty text blocks: PASS');

    // Step 4: Resume forked session and verify it works
    console.log('Step 4: Resuming forked session...');
    const resumeQuery = query({
      prompt: 'What is 7+7? Reply with just the number.',
      options: {
        resume: forkedSessionId!,
        permissionMode: 'bypassPermissions',
        outputFormat: 'stream-json',
      },
    });

    let gotResponse = false;

    for await (const event of resumeQuery) {
      if (event.type === 'assistant' && (event as any).message?.content) {
        const text = (event as any).message.content[0]?.text;
        if (text && text.includes('14')) {
          gotResponse = true;
          console.log('Resume response:', text.slice(0, 50));
          break;
        }
      }
    }

    expect(gotResponse).toBe(true);
    console.log('Resume successful: PASS');
  }, 60000);
});
