import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ConcurrentCheckResult {
  active: boolean;
  pid?: number;
  command?: string;
}

/**
 * Check if a session is currently active in a terminal
 * by looking for `claude --resume <sessionId>` in running processes
 */
export async function isSessionActiveInTerminal(sessionId: string): Promise<ConcurrentCheckResult> {
  try {
    // Search for the exact command pattern we provide users
    const expectedCommand = `claude --resume ${sessionId}`;
    const { stdout } = await execAsync(
      `ps aux | grep "${expectedCommand}" | grep -v grep`
    );

    const lines = stdout.trim().split('\n').filter(line => line.length > 0);

    if (lines.length > 0) {
      // Parse the first matching line
      // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const parts = lines[0].trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);

      return {
        active: true,
        pid,
        command: expectedCommand,
      };
    }

    return { active: false };
  } catch (error) {
    // grep returns exit code 1 if no matches found
    return { active: false };
  }
}

/**
 * Generate the command string for users to continue in terminal
 */
export function getContinueCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

/**
 * Build Slack blocks for concurrent session warning
 */
export function buildConcurrentWarningBlocks(pid: number, sessionId: string): any[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Warning:* This session is currently active in your terminal (PID: ${pid})`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Close the terminal session first, or proceed anyway (may cause conflicts).`,
        },
      ],
    },
    {
      type: "actions",
      block_id: `concurrent_${sessionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: `concurrent_cancel_${sessionId}`,
          value: "cancel",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Proceed Anyway" },
          style: "danger",
          action_id: `concurrent_proceed_${sessionId}`,
          value: "proceed",
        },
      ],
    },
  ];
}
