import { describe, it, expect } from 'vitest';
import { buildStatusPanelBlocks } from '../../blocks.js';

describe('Abort button during active session (View Log removed)', () => {
  const baseParams = {
    mode: 'plan' as const,
    toolsCompleted: 0,
    elapsedMs: 0,
    conversationKey: 'C123',
  };

  describe('buildStatusPanelBlocks - Abort button only (no View Log)', () => {
    it('should include only Abort button for starting status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'starting',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();

      // Should have only 1 button (Abort)
      expect(actionsBlock?.elements).toHaveLength(1);

      const abortButton = actionsBlock?.elements?.[0];
      expect(abortButton?.text?.text).toBe('Abort');
      expect(abortButton?.style).toBe('danger');
      expect(abortButton?.action_id).toContain('abort_query_');

      // No View Log button
      const viewLogButton = actionsBlock?.elements?.find(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      expect(viewLogButton).toBeUndefined();
    });

    it('should include only Abort button for thinking status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'thinking',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock?.elements).toHaveLength(1);
      expect(actionsBlock?.elements?.[0]?.text?.text).toBe('Abort');
    });

    it('should include only Abort button for tool status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'tool',
        currentTool: 'Read',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock?.elements).toHaveLength(1);
      expect(actionsBlock?.elements?.[0]?.text?.text).toBe('Abort');
    });

    it('should include only Abort button for generating status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'generating',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock?.elements).toHaveLength(1);
      expect(actionsBlock?.elements?.[0]?.text?.text).toBe('Abort');
    });

    it('should NOT include any buttons for complete status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'complete',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      // Complete status should not have actions block at all
      expect(actionsBlock).toBeUndefined();
    });

    it('should NOT include any buttons for error status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'error',
        errorMessage: 'Test error',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });

    it('should NOT include any buttons for aborted status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'aborted',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });

    it('should have Abort button as only element during active status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'tool',
        currentTool: 'Grep',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock?.elements).toHaveLength(1);

      const abortButton = actionsBlock?.elements?.[0];
      expect(abortButton?.text?.text).toBe('Abort');
      expect(abortButton?.style).toBe('danger');
    });
  });
});
