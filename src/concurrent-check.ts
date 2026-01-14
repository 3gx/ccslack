import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ConcurrentCheckResult {
  active: boolean;
  pid?: number;
  command?: string;
}

/**
 * Check if a session is currently active in a terminal.
 *
 * TODO: CONCURRENT SESSION DETECTION NEEDS INVESTIGATION
 * ======================================================
 *
 * We need a robust way to detect if `claude --resume <sessionId>` is running
 * in a terminal. Current approaches that DON'T work on macOS:
 *
 * 1. `ps aux | grep "claude --resume <sessionId>"`
 *    - macOS truncates command-line args in ps output
 *    - Only shows "claude" without the --resume argument
 *
 * 2. `lsof <session-file.jsonl>`
 *    - Claude doesn't keep the session file open continuously
 *    - Opens, writes, closes - so lsof finds nothing
 *
 * 3. Working directory matching via `lsof -d cwd`
 *    - Too broad - catches ANY Claude in same directory
 *    - False positives for unrelated Claude sessions
 *
 * 4. File modification time heuristics
 *    - Unreliable, requires arbitrary thresholds
 *
 * DIRECTIONS TO INVESTIGATE:
 * - macOS proc_info/libproc APIs for full command args
 * - sysctl kern.procargs2 for process arguments
 * - Whether Claude creates lock/PID files we can check
 * - Claude hooks or config that tracks active sessions
 * - FSEvents/kqueue for file system monitoring
 * - DTrace for tracing file access
 *
 * For now, this feature is DISABLED until we find a robust solution.
 */
export async function isSessionActiveInTerminal(
  sessionId: string,
  workingDir?: string
): Promise<ConcurrentCheckResult> {
  // DISABLED: No reliable detection method found yet
  // See TODO above for investigation directions
  return { active: false };

  /* Original implementation commented out:
  if (!sessionId) {
    return { active: false };
  }

  try {
    const projectPath = workingDir?.replace(/\//g, '-').replace(/^-/, '-') || '';
    const sessionFile = `${process.env.HOME}/.claude/projects/${projectPath}/${sessionId}.jsonl`;

    const { stdout } = await execAsync(
      `lsof "${sessionFile}" 2>/dev/null | grep -v "^COMMAND"`
    );

    const lines = stdout.trim().split('\n').filter(line => line.length > 0);

    if (lines.length === 0) {
      return { active: false };
    }

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);

      if (isNaN(pid)) continue;

      try {
        const { stdout: psOutput } = await execAsync(
          `ps -p ${pid} -o tty= 2>/dev/null`
        );
        const tty = psOutput.trim();

        if (tty && tty !== '??' && tty !== '') {
          return {
            active: true,
            pid,
            command: `claude --resume ${sessionId}`,
          };
        }
      } catch {
        continue;
      }
    }

    return { active: false };
  } catch (error) {
    return { active: false };
  }
  */
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
