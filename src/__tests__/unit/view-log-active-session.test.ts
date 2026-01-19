import { describe, it, expect } from 'vitest';
import { buildStatusPanelBlocks } from '../../blocks.js';

describe('View Log button during active session', () => {
  const baseParams = {
    mode: 'plan' as const,
    toolsCompleted: 0,
    elapsedMs: 0,
    conversationKey: 'C123',
  };

  describe('buildStatusPanelBlocks - View Log button presence', () => {
    it('should include View Log button for starting status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'starting',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();

      const viewLogButton = actionsBlock?.elements?.find(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      expect(viewLogButton).toBeDefined();
      expect(viewLogButton?.text?.text).toBe('View Log');
      expect(viewLogButton?.value).toBe('C123');
    });

    it('should include View Log button for thinking status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'thinking',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const viewLogButton = actionsBlock?.elements?.find(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      expect(viewLogButton).toBeDefined();
    });

    it('should include View Log button for tool status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'tool',
        currentTool: 'Read',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const viewLogButton = actionsBlock?.elements?.find(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      expect(viewLogButton).toBeDefined();
    });

    it('should include View Log button for generating status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'generating',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const viewLogButton = actionsBlock?.elements?.find(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      expect(viewLogButton).toBeDefined();
    });

    it('should NOT include View Log button for complete status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'complete',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      // Complete status should not have actions block at all
      expect(actionsBlock).toBeUndefined();
    });

    it('should NOT include View Log button for error status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'error',
        errorMessage: 'Test error',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });

    it('should NOT include View Log button for aborted status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'aborted',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });

    it('should place View Log button before Abort button', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'thinking',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const elements = actionsBlock?.elements || [];

      const viewLogIndex = elements.findIndex(
        (e: any) => e.action_id?.startsWith('view_activity_log_')
      );
      const abortIndex = elements.findIndex(
        (e: any) => e.action_id?.startsWith('abort_query_')
      );

      expect(viewLogIndex).toBe(0);
      expect(abortIndex).toBe(1);
      expect(viewLogIndex).toBeLessThan(abortIndex);
    });

    it('should include both View Log and Abort buttons during active status', () => {
      const blocks = buildStatusPanelBlocks({
        ...baseParams,
        status: 'tool',
        currentTool: 'Grep',
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock?.elements).toHaveLength(2);

      const viewLogButton = actionsBlock?.elements?.[0];
      const abortButton = actionsBlock?.elements?.[1];

      expect(viewLogButton?.text?.text).toBe('View Log');
      expect(abortButton?.text?.text).toBe('Abort');
      expect(abortButton?.style).toBe('danger');
    });
  });
});
