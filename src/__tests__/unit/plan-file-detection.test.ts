import { describe, it, expect } from 'vitest';

describe('Plan file detection', () => {
  // Helper to create stream events
  const createBlockStart = (index: number, toolName: string) => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', name: toolName },
  });

  const createBlockDelta = (index: number, partialJson: string) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });

  const createBlockStop = (index: number) => ({
    type: 'content_block_stop',
    index,
  });

  // Helper to simulate the NEW tracking logic (tracks all tool_use blocks)
  const trackAllToolUse = (event: any, fileToolInputs: Map<number, string>) => {
    if (event.content_block?.type === 'tool_use') {
      fileToolInputs.set(event.index, '');
    }
  };

  // Helper to simulate the NEW plan path detection logic (checks both file_path and path)
  const detectPlanPath = (inputJson: string): string | null => {
    try {
      const input = JSON.parse(inputJson);
      const planPath = input.file_path || input.path;
      if (typeof planPath === 'string' && planPath.includes('.claude/plans/')) {
        return planPath;
      }
    } catch (e) {
      // Parse error
    }
    return null;
  };

  describe('Write tool detection', () => {
    it('should detect plan file from Write tool', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Simulate Write tool for plan file
      const startEvent = createBlockStart(5, 'Write');
      trackAllToolUse(startEvent, fileToolInputs);

      // Accumulate JSON
      const deltaEvent = createBlockDelta(5, '{"file_path":"/home/user/.claude/plans/test.md"}');
      if (fileToolInputs.has(deltaEvent.index)) {
        const current = fileToolInputs.get(deltaEvent.index) || '';
        fileToolInputs.set(deltaEvent.index, current + deltaEvent.delta.partial_json);
      }

      // Complete and check
      const stopEvent = createBlockStop(5);
      if (fileToolInputs.has(stopEvent.index)) {
        planFilePath = detectPlanPath(fileToolInputs.get(stopEvent.index) || '{}');
        fileToolInputs.delete(stopEvent.index);
      }

      expect(planFilePath).toBe('/home/user/.claude/plans/test.md');
      expect(fileToolInputs.size).toBe(0);
    });
  });

  describe('Edit tool detection', () => {
    it('should detect plan file from Edit tool', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Simulate Edit tool for plan file
      const startEvent = createBlockStart(7, 'Edit');
      trackAllToolUse(startEvent, fileToolInputs);

      // Accumulate JSON
      const deltaEvent = createBlockDelta(7, '{"file_path":"/home/user/.claude/plans/my-plan.md"}');
      if (fileToolInputs.has(deltaEvent.index)) {
        const current = fileToolInputs.get(deltaEvent.index) || '';
        fileToolInputs.set(deltaEvent.index, current + deltaEvent.delta.partial_json);
      }

      // Complete and check
      const stopEvent = createBlockStop(7);
      if (fileToolInputs.has(stopEvent.index)) {
        planFilePath = detectPlanPath(fileToolInputs.get(stopEvent.index) || '{}');
        fileToolInputs.delete(stopEvent.index);
      }

      expect(planFilePath).toBe('/home/user/.claude/plans/my-plan.md');
    });
  });

  describe('Read tool detection', () => {
    it('should detect plan file from Read tool (verify existing plan)', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Simulate Read tool for plan file (when verifying existing plan)
      const startEvent = createBlockStart(9, 'Read');
      trackAllToolUse(startEvent, fileToolInputs);

      // Accumulate JSON
      const deltaEvent = createBlockDelta(9, '{"file_path":"/home/user/.claude/plans/existing-plan.md"}');
      if (fileToolInputs.has(deltaEvent.index)) {
        const current = fileToolInputs.get(deltaEvent.index) || '';
        fileToolInputs.set(deltaEvent.index, current + deltaEvent.delta.partial_json);
      }

      // Complete and check
      const stopEvent = createBlockStop(9);
      if (fileToolInputs.has(stopEvent.index)) {
        planFilePath = detectPlanPath(fileToolInputs.get(stopEvent.index) || '{}');
        fileToolInputs.delete(stopEvent.index);
      }

      expect(planFilePath).toBe('/home/user/.claude/plans/existing-plan.md');
    });
  });

  describe('Grep tool detection (path parameter)', () => {
    it('should detect plan file from Grep tool using path parameter', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Simulate Grep tool with path parameter
      const startEvent = createBlockStart(11, 'Grep');
      trackAllToolUse(startEvent, fileToolInputs);

      // Grep uses 'path' instead of 'file_path'
      const deltaEvent = createBlockDelta(11, '{"path":"/home/.claude/plans/grep-plan.md","pattern":"foo"}');
      if (fileToolInputs.has(deltaEvent.index)) {
        const current = fileToolInputs.get(deltaEvent.index) || '';
        fileToolInputs.set(deltaEvent.index, current + deltaEvent.delta.partial_json);
      }

      // Complete and check
      const stopEvent = createBlockStop(11);
      if (fileToolInputs.has(stopEvent.index)) {
        planFilePath = detectPlanPath(fileToolInputs.get(stopEvent.index) || '{}');
        fileToolInputs.delete(stopEvent.index);
      }

      expect(planFilePath).toBe('/home/.claude/plans/grep-plan.md');
    });
  });

  describe('Glob tool detection (path parameter)', () => {
    it('should detect plan file from Glob tool using path parameter', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Simulate Glob tool with path parameter
      const startEvent = createBlockStart(13, 'Glob');
      trackAllToolUse(startEvent, fileToolInputs);

      // Glob uses 'path' instead of 'file_path'
      const deltaEvent = createBlockDelta(13, '{"path":"/home/.claude/plans/","pattern":"*.md"}');
      if (fileToolInputs.has(deltaEvent.index)) {
        const current = fileToolInputs.get(deltaEvent.index) || '';
        fileToolInputs.set(deltaEvent.index, current + deltaEvent.delta.partial_json);
      }

      // Complete and check
      const stopEvent = createBlockStop(13);
      if (fileToolInputs.has(stopEvent.index)) {
        planFilePath = detectPlanPath(fileToolInputs.get(stopEvent.index) || '{}');
        fileToolInputs.delete(stopEvent.index);
      }

      // Glob path to directory also matches
      expect(planFilePath).toBe('/home/.claude/plans/');
    });
  });

  describe('Concurrent tools', () => {
    it('should track multiple tools simultaneously without overwriting', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Start Write for plan file (index 5)
      const writeEvent = createBlockStart(5, 'Write');
      trackAllToolUse(writeEvent, fileToolInputs);

      // Start Edit for code file (index 7) - should NOT overwrite index 5
      const editEvent = createBlockStart(7, 'Edit');
      trackAllToolUse(editEvent, fileToolInputs);

      // Accumulate JSON for both
      fileToolInputs.set(5, '{"file_path":"/home/.claude/plans/plan.md"}');
      fileToolInputs.set(7, '{"file_path":"/home/project/src/code.ts"}');

      // Complete code file first (index 7)
      planFilePath = detectPlanPath(fileToolInputs.get(7) || '{}');
      fileToolInputs.delete(7);

      // Code file should NOT match plan path
      expect(planFilePath).toBeNull();

      // Plan file entry should still exist
      expect(fileToolInputs.has(5)).toBe(true);

      // Now complete plan file (index 5)
      planFilePath = detectPlanPath(fileToolInputs.get(5) || '{}');
      fileToolInputs.delete(5);

      expect(planFilePath).toBe('/home/.claude/plans/plan.md');
      expect(fileToolInputs.size).toBe(0);
    });
  });

  describe('Non-plan files', () => {
    it('should NOT capture non-plan file paths', () => {
      const fileToolInputs = new Map<number, string>();

      fileToolInputs.set(3, '{"file_path":"/home/project/src/app.ts"}');

      const planFilePath = detectPlanPath(fileToolInputs.get(3) || '{}');

      expect(planFilePath).toBeNull();
    });

    it('should NOT capture non-plan path parameters', () => {
      const fileToolInputs = new Map<number, string>();

      // Grep tool with non-plan path
      fileToolInputs.set(4, '{"path":"/home/project/src","pattern":"foo"}');

      const planFilePath = detectPlanPath(fileToolInputs.get(4) || '{}');

      expect(planFilePath).toBeNull();
    });
  });

  describe('Chunked JSON input', () => {
    it('should handle JSON split across multiple delta events', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Start Edit tool
      const startEvent = createBlockStart(2, 'Edit');
      trackAllToolUse(startEvent, fileToolInputs);

      // Simulate JSON arriving in chunks (as happens with streaming)
      const chunks = [
        '{"file_',
        'path":"/home/',
        '.claude/plans/',
        'chunked-plan.md"}'
      ];

      for (const chunk of chunks) {
        const current = fileToolInputs.get(2) || '';
        fileToolInputs.set(2, current + chunk);
      }

      // Complete and check
      planFilePath = detectPlanPath(fileToolInputs.get(2) || '{}');
      fileToolInputs.delete(2);

      expect(planFilePath).toBe('/home/.claude/plans/chunked-plan.md');
    });

    it('should handle chunked path parameter (Grep)', () => {
      const fileToolInputs = new Map<number, string>();
      let planFilePath: string | null = null;

      // Start Grep tool
      const startEvent = createBlockStart(15, 'Grep');
      trackAllToolUse(startEvent, fileToolInputs);

      // Simulate JSON arriving in chunks
      const chunks = [
        '{"path":"/home/',
        '.claude/',
        'plans/my-plan.md",',
        '"pattern":"foo"}'
      ];

      for (const chunk of chunks) {
        const current = fileToolInputs.get(15) || '';
        fileToolInputs.set(15, current + chunk);
      }

      // Complete and check
      planFilePath = detectPlanPath(fileToolInputs.get(15) || '{}');
      fileToolInputs.delete(15);

      expect(planFilePath).toBe('/home/.claude/plans/my-plan.md');
    });
  });

  describe('All tool_use blocks tracking', () => {
    it('should track Bash tool (even though it has no file path)', () => {
      const fileToolInputs = new Map<number, string>();

      // Bash tool should now be tracked
      const bashEvent = createBlockStart(20, 'Bash');
      trackAllToolUse(bashEvent, fileToolInputs);

      expect(fileToolInputs.has(20)).toBe(true);

      // But Bash has no file_path or path param, so no plan path detected
      fileToolInputs.set(20, '{"command":"ls -la"}');
      const planFilePath = detectPlanPath(fileToolInputs.get(20) || '{}');

      expect(planFilePath).toBeNull();
    });

    it('should track Task tool (even though it has no file path)', () => {
      const fileToolInputs = new Map<number, string>();

      // Task tool should now be tracked
      const taskEvent = createBlockStart(21, 'Task');
      trackAllToolUse(taskEvent, fileToolInputs);

      expect(fileToolInputs.has(21)).toBe(true);

      // But Task has no file_path or path param
      fileToolInputs.set(21, '{"prompt":"search for X","subagent_type":"Explore"}');
      const planFilePath = detectPlanPath(fileToolInputs.get(21) || '{}');

      expect(planFilePath).toBeNull();
    });
  });

  describe('file_path takes precedence over path', () => {
    it('should prefer file_path when both are present', () => {
      const fileToolInputs = new Map<number, string>();

      // Edge case: both file_path and path present (shouldn't happen, but test precedence)
      fileToolInputs.set(30, '{"file_path":"/home/.claude/plans/plan-a.md","path":"/home/.claude/plans/plan-b.md"}');

      const planFilePath = detectPlanPath(fileToolInputs.get(30) || '{}');

      // file_path should take precedence (appears first in || expression)
      expect(planFilePath).toBe('/home/.claude/plans/plan-a.md');
    });
  });
});
