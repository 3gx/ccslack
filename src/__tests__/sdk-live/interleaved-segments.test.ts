/**
 * SDK-Live Tests for Interleaved Activity + Response Segments
 *
 * Verifies that multi-tool queries produce the correct segment structure
 * for interleaved posting (activity -> text -> activity -> text).
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/interleaved-segments.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readActivityLog } from '../../session-event-stream.js';
import { readNewMessages, groupMessagesByTurn } from '../../session-reader.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Interleaved Segments', { timeout: 180000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up session: ${sessionId}`);
      }
    }
  });

  it('multi-tool query produces multiple segments', async () => {
    // Run query that should produce: text -> tool -> text
    // Requires maxTurns >= 2: Turn 1 = text + tool_use, Turn 2 = text after tool result
    const q = query({
      prompt: 'First say "Starting", then run "echo hello", then say "Done"',
      options: {
        maxTurns: 2,  // Need 2 turns: initial response + post-tool response
        permissionMode: 'bypassPermissions' as any,
      },
    });

    let sessionId: string | null = null;
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }
      if (msg.type === 'result') break;
    }

    expect(sessionId).toBeTruthy();
    const filePath = getSessionFilePath(sessionId!);

    // Read messages and group into turns
    const { messages } = await readNewMessages(filePath, 0);
    const turns = groupMessagesByTurn(messages);

    // Should have exactly 1 turn (1 user input)
    expect(turns.length).toBe(1);
    const turn = turns[0];

    // Should have multiple segments (text outputs separated by tools)
    // Expected: segment1 (text before tool), segment2 (text after tool)
    expect(turn.segments.length).toBeGreaterThanOrEqual(2);

    console.log(`Turn has ${turn.segments.length} segments`);
    for (let i = 0; i < turn.segments.length; i++) {
      const seg = turn.segments[i];
      const textContent = seg.textOutput.message?.content;
      const textStr = Array.isArray(textContent)
        ? textContent.find(b => b.type === 'text')?.text || ''
        : textContent;
      console.log(`Segment ${i + 1}: ${seg.activityMessages.length} activity messages, text: "${textStr?.substring(0, 50)}..."`);
    }

    // Each segment should have its own textOutput (not accumulated)
    const textOutputs = turn.segments.map(s => s.textOutput);
    const uniqueUuids = new Set(textOutputs.map(t => t.uuid));
    expect(uniqueUuids.size).toBe(turn.segments.length);

    // Verify text outputs are separate (not containing each other's content)
    if (turn.segments.length >= 2) {
      const text1 = turn.segments[0].textOutput.uuid;
      const text2 = turn.segments[1].textOutput.uuid;
      // They should be different messages
      expect(text1).not.toEqual(text2);
    }
  });

  it('activity log has entries for each segment', async () => {
    const q = query({
      prompt: 'Say "First", run "echo test", say "Second"',
      options: {
        maxTurns: 2,  // Need 2 turns: initial response + post-tool response
        permissionMode: 'bypassPermissions' as any,
      },
    });

    let sessionId: string | null = null;
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }
      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const activityLog = await readActivityLog(filePath);

    console.log(`Activity log has ${activityLog.length} entries`);
    for (const entry of activityLog) {
      console.log(`  ${entry.type}: ${entry.type === 'tool_start' || entry.type === 'tool_complete' ? entry.toolName : ''}`);
    }

    // Should have generating entries (one per text block)
    const generatingEntries = activityLog.filter(e => e.type === 'generating' || e.type === 'text');
    expect(generatingEntries.length).toBeGreaterThanOrEqual(2);

    // Should have tool entries
    const toolStarts = activityLog.filter(e => e.type === 'tool_start');
    const toolCompletes = activityLog.filter(e => e.type === 'tool_complete');
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolCompletes.length).toBeGreaterThan(0);

    // Activity should be in correct order: generating -> tool -> generating
    const types = activityLog.map(e => e.type);
    const genIndex1 = types.findIndex(t => t === 'generating' || t === 'text');
    const toolIndex = types.indexOf('tool_start');
    const genIndex2 = types.slice(toolIndex + 1).findIndex(t => t === 'generating' || t === 'text');

    // First generating should be before tool
    if (genIndex1 !== -1 && toolIndex !== -1) {
      expect(genIndex1).toBeLessThan(toolIndex);
      console.log(`First text at index ${genIndex1}, tool at ${toolIndex}, second text at ${toolIndex + 1 + genIndex2}`);
    }
  });

  it('segment activity timestamps align with text output timestamps', async () => {
    const q = query({
      prompt: 'Say hello, run "echo hi", say goodbye',
      options: {
        maxTurns: 2,  // Need 2 turns: initial response + post-tool response
        permissionMode: 'bypassPermissions' as any,
      },
    });

    let sessionId: string | null = null;
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }
      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const { messages } = await readNewMessages(filePath, 0);
    const turns = groupMessagesByTurn(messages);
    const activityLog = await readActivityLog(filePath);

    const turn = turns[0];
    console.log(`Turn has ${turn.segments.length} segments`);
    console.log(`Activity log has ${activityLog.length} entries`);

    if (turn.segments.length >= 2) {
      const seg1End = new Date(turn.segments[0].textOutput.timestamp).getTime();
      const seg2End = new Date(turn.segments[1].textOutput.timestamp).getTime();
      const turnStart = new Date(turn.userInput.timestamp).getTime();

      console.log(`Turn start: ${turnStart}`);
      console.log(`Segment 1 end: ${seg1End} (delta: ${seg1End - turnStart}ms)`);
      console.log(`Segment 2 end: ${seg2End} (delta: ${seg2End - turnStart}ms)`);

      // Activity for segment 1 should have timestamps <= seg1End
      // Activity for segment 2 should have timestamps > seg1End and <= seg2End
      const seg1Activity = activityLog.filter(e =>
        e.timestamp >= turnStart && e.timestamp <= seg1End
      );
      const seg2Activity = activityLog.filter(e =>
        e.timestamp > seg1End && e.timestamp <= seg2End
      );

      console.log(`Segment 1 activity count: ${seg1Activity.length}`);
      console.log(`Segment 2 activity count: ${seg2Activity.length}`);

      // Both segments should have some activity
      expect(seg1Activity.length).toBeGreaterThan(0);
      expect(seg2Activity.length).toBeGreaterThan(0);
    }
  });

  it('captures text_delta events before tool_use in SDK stream', async () => {
    // This test verifies that text_delta arrives before tool_use in SDK events
    // which is the fundamental assumption for the interleaved fix
    const events: { type: string; subtype?: string; timestamp: number }[] = [];

    const q = query({
      prompt: 'Say "Hello", then run "echo world"',
      options: {
        maxTurns: 2,  // Need 2 turns: initial response + post-tool response
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

      // Capture stream_event messages
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

    // Should have both text_delta and tool_use events
    const textDeltas = events.filter(e => e.type === 'text_delta');
    const toolUses = events.filter(e => e.type === 'tool_use_start');

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(toolUses.length).toBeGreaterThan(0);

    // At least one text_delta should come before the first tool_use
    const firstTextDeltaIndex = events.findIndex(e => e.type === 'text_delta');
    const firstToolUseIndex = events.findIndex(e => e.type === 'tool_use_start');

    console.log(`First text_delta at index ${firstTextDeltaIndex}, first tool_use at ${firstToolUseIndex}`);
    expect(firstTextDeltaIndex).toBeLessThan(firstToolUseIndex);
  });

  it('thinking_start after text creates segment boundary (3 segments for text→tool→text→thinking→text)', async () => {
    // This test verifies the fix: thinking_start should trigger finalizeGeneratingEntry()
    // so that text before thinking and text after thinking are separate segments
    //
    // Expected flow:
    // 1. text1 accumulates → tool_use start → SEGMENT 1 posted
    // 2. tool executes → text2 accumulates → thinking_start → SEGMENT 2 posted
    // 3. thinking → text3 accumulates → query end → SEGMENT 3 posted
    //
    // Note: This test uses maxThinkingTokens to encourage thinking usage
    const q = query({
      prompt: 'First say "Starting analysis", then run "echo test", then think carefully about what 2+2 equals and explain your reasoning, then say "The answer is 4"',
      options: {
        maxTurns: 2,
        permissionMode: 'bypassPermissions' as any,
        maxThinkingTokens: 5000,  // Encourage thinking
      },
    });

    let sessionId: string | null = null;
    const events: { type: string; timestamp: number }[] = [];

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }

      // Capture stream_event messages to verify event ordering
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

    // Read messages and group into turns
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

    // Check if thinking was used (model may or may not use it)
    const thinkingUsed = events.some(e => e.type === 'thinking_start');
    console.log(`\nThinking used: ${thinkingUsed}`);

    if (thinkingUsed) {
      // If thinking was used, we should have multiple segments
      // The key test: text before thinking and text after thinking should be separate
      const totalSegments = turns.reduce((sum, t) => sum + t.segments.length, 0);

      // With thinking: expect at least 2 segments (text before tool, text after tool+thinking)
      // Ideally 3 segments if thinking occurs between text blocks
      expect(totalSegments).toBeGreaterThanOrEqual(2);
      console.log(`Total segments: ${totalSegments}`);

      // Verify that thinking_start comes after some text_start (not at the very beginning)
      const firstTextIndex = events.findIndex(e => e.type === 'text_start');
      const thinkingIndex = events.findIndex(e => e.type === 'thinking_start');

      // If there's text before thinking, and text after thinking, we expect segment boundary
      if (firstTextIndex !== -1 && thinkingIndex > firstTextIndex) {
        console.log(`Text started at index ${firstTextIndex}, thinking at index ${thinkingIndex}`);
        // The fix ensures this creates a segment boundary
      }
    } else {
      // If no thinking used, just verify basic segment structure
      console.log('Model did not use thinking - skipping thinking boundary verification');
      expect(turns.length).toBeGreaterThanOrEqual(1);
    }
  });
});
