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
 * by finding claude processes with a TTY and matching their working directory
 *
 * macOS `ps` truncates command-line args, so we can't search for `--resume <sessionId>`.
 * Instead, we check if any terminal claude process is in the same working directory.
 */
export async function isSessionActiveInTerminal(
  sessionId: string,
  workingDir?: string
): Promise<ConcurrentCheckResult> {
  if (!workingDir) {
    return { active: false };
  }

  try {
    // Step 1: Find all claude processes with a TTY (terminal sessions)
    // Format: PID TTY COMM - filter out processes with '??' (no TTY)
    const { stdout: psOutput } = await execAsync(
      `ps -eo pid,tty,comm | grep claude | grep -v "??" | grep -v grep`
    );

    const lines = psOutput.trim().split('\n').filter(line => line.length > 0);

    if (lines.length === 0) {
      return { active: false };
    }

    // Step 2: For each claude process with TTY, check its working directory
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);

      if (isNaN(pid)) continue;

      try {
        // Get working directory using lsof
        const { stdout: lsofOutput } = await execAsync(
          `lsof -a -d cwd -p ${pid} 2>/dev/null | grep cwd`
        );

        // Parse lsof output to get the directory path
        // Format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        const lsofParts = lsofOutput.trim().split(/\s+/);
        const processCwd = lsofParts[lsofParts.length - 1]; // Last column is NAME (path)

        // Check if this process is in the same working directory
        if (processCwd === workingDir) {
          return {
            active: true,
            pid,
            command: `claude (in ${workingDir})`,
          };
        }
      } catch {
        // lsof failed for this PID, skip it
        continue;
      }
    }

    return { active: false };
  } catch (error) {
    // No claude processes found or error
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
