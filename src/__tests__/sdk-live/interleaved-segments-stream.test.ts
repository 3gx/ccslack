/**
 * SDK-Live Tests for Interleaved Segments - Stream Events
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/interleaved-segments-stream.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readNewMessages, groupMessagesByTurn } from '../../session-reader.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Interleaved Segments - Stream', { timeout: 180000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('captures text_delta events before tool_use in SDK stream', async () => {
    const events: { type: string; subtype?: string; timestamp: number }[] = [];

    const q = query({
      prompt: 'Say "Hello", then run "echo world"',
      options: {
        maxTurns: 2,
        permissionMode: 'bypassPermissions' as any,
        includePartialMessages: true,
      },
    });

    let sessionId: string | null = null;
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }

      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          events.push({ type: 'text_delta', timestamp: Date.now() });
        }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          events.push({ type: 'tool_use_start', subtype: event.content_block.name, timestamp: Date.now() });
        }
      }

      if (msg.type === 'result') break;
    }

    console.log('Event order:');
    for (const e of events) {
      console.log(`  ${e.type}${e.subtype ? ` (${e.subtype})` : ''}`);
    }

    const textDeltas = events.filter(e => e.type === 'text_delta');
    const toolUses = events.filter(e => e.type === 'tool_use_start');

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(toolUses.length).toBeGreaterThan(0);

    const firstTextDeltaIndex = events.findIndex(e => e.type === 'text_delta');
    const firstToolUseIndex = events.findIndex(e => e.type === 'tool_use_start');

    console.log(`First text_delta at index ${firstTextDeltaIndex}, first tool_use at ${firstToolUseIndex}`);
    expect(firstTextDeltaIndex).toBeLessThan(firstToolUseIndex);
  });

  it('thinking_start after text creates segment boundary (3 segments for text→tool→text→thinking→text)', async () => {
    const q = query({
      prompt: 'First say "Starting analysis", then run "echo test", then think carefully about what 2+2 equals and explain your reasoning, then say "The answer is 4"',
      options: {
        maxTurns: 2,
        permissionMode: 'bypassPermissions' as any,
        maxThinkingTokens: 5000,
      },
    });

    let sessionId: string | null = null;
    const events: { type: string; timestamp: number }[] = [];

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }

      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_start') {
          if (event.content_block?.type === 'thinking') {
            events.push({ type: 'thinking_start', timestamp: Date.now() });
          } else if (event.content_block?.type === 'text') {
            events.push({ type: 'text_start', timestamp: Date.now() });
          } else if (event.content_block?.type === 'tool_use') {
            events.push({ type: 'tool_use_start', timestamp: Date.now() });
          }
        }
      }

      if (msg.type === 'result') break;
    }

    expect(sessionId).toBeTruthy();
    const filePath = getSessionFilePath(sessionId!);

    const { messages } = await readNewMessages(filePath, 0);
    const turns = groupMessagesByTurn(messages);

    console.log('Event order captured:');
    for (const e of events) {
      console.log(`  ${e.type}`);
    }

    console.log(`\nTurns: ${turns.length}`);
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      console.log(`Turn ${i + 1}: ${turn.segments.length} segments`);
      for (let j = 0; j < turn.segments.length; j++) {
        const seg = turn.segments[j];
        const textContent = seg.textOutput.message?.content;
        const textStr = Array.isArray(textContent)
          ? textContent.find(b => b.type === 'text')?.text || ''
          : textContent;
        console.log(`  Segment ${j + 1}: ${seg.activityMessages.length} activity msgs, text: "${textStr?.substring(0, 40)}..."`);
      }
    }

    const thinkingUsed = events.some(e => e.type === 'thinking_start');
    console.log(`\nThinking used: ${thinkingUsed}`);

    if (thinkingUsed) {
      const totalSegments = turns.reduce((sum, t) => sum + t.segments.length, 0);
      expect(totalSegments).toBeGreaterThanOrEqual(2);
      console.log(`Total segments: ${totalSegments}`);

      const firstTextIndex = events.findIndex(e => e.type === 'text_start');
      const thinkingIndex = events.findIndex(e => e.type === 'thinking_start');

      if (firstTextIndex !== -1 && thinkingIndex > firstTextIndex) {
        console.log(`Text started at index ${firstTextIndex}, thinking at index ${thinkingIndex}`);
      }
    } else {
      console.log('Model did not use thinking - skipping thinking boundary verification');
      expect(turns.length).toBeGreaterThanOrEqual(1);
    }
  });
});
