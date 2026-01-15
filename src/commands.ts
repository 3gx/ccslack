/**
 * Command parser and handlers for slash commands.
 * Commands are prefixed with `/` (e.g., /status, /mode, /continue)
 */

import { Session, PermissionMode } from './session-manager.js';
import {
  Block,
  buildStatusDisplayBlocks,
  buildTerminalCommandBlocks,
  buildModeSelectionBlocks,
} from './blocks.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
  blocks?: Block[];
  sessionUpdate?: Partial<Session>;
  // For /fork-thread command - caller handles the actual forking
  forkThread?: {
    description: string;
  };
}

/**
 * Parse and handle slash commands.
 * Returns { handled: false } if text is not a command (passes to Claude).
 */
export function parseCommand(
  text: string,
  session: Session
): CommandResult {
  // Only handle slash commands
  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const [command, ...args] = text.slice(1).split(/\s+/);
  const argString = args.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'help':
      return handleHelp();
    case 'status':
      return handleStatus(session);
    case 'mode':
      return handleMode(argString, session);
    case 'cwd':
      return handleCwd(argString, session);
    case 'continue':
      return handleContinue(session);
    case 'fork':
      return handleFork(session);
    case 'fork-thread':
      return handleForkThread(argString);
    case 'resume':
      return handleResume(argString);
    default:
      // Unknown command - return error
      return {
        handled: true,
        response: `Unknown command: \`/${command}\`\nType \`/help\` for available commands.`,
      };
  }
}

/**
 * /help - Show available commands
 */
function handleHelp(): CommandResult {
  const helpText = `*Available Commands*
\`/help\` - Show this help message
\`/status\` - Show session info (ID, mode, directory)
\`/mode\` - Show mode picker
\`/cwd\` - Show current working directory
\`/continue\` - Get command to continue session in terminal
\`/fork\` - Get command to fork session to terminal
\`/fork-thread [desc]\` - Fork current thread to new thread
\`/resume <id>\` - Resume a terminal session in Slack`;

  return {
    handled: true,
    response: helpText,
  };
}

/**
 * /status - Show session status
 */
function handleStatus(session: Session): CommandResult {
  return {
    handled: true,
    blocks: buildStatusDisplayBlocks({
      sessionId: session.sessionId,
      mode: session.mode,
      workingDir: session.workingDir,
      lastActiveAt: session.lastActiveAt,
    }),
  };
}

/**
 * /mode - Show mode picker (selection only, no typed arguments)
 */
function handleMode(modeArg: string, session: Session): CommandResult {
  // If user tries to type a mode, redirect to selection UI
  if (modeArg) {
    return {
      handled: true,
      response: `Please use the mode picker to select a mode.`,
      blocks: buildModeSelectionBlocks(session.mode),
    };
  }

  // Show button selection UI
  return {
    handled: true,
    blocks: buildModeSelectionBlocks(session.mode),
  };
}

/**
 * /cwd - Show current working directory
 * Note: Changing directory is disabled because Claude Code SDK
 * stores sessions per-directory and cannot resume across directories.
 */
function handleCwd(pathArg: string, session: Session): CommandResult {
  if (pathArg) {
    return {
      handled: true,
      response: `Changing working directory is not supported.\nCurrent directory: \`${session.workingDir}\``,
    };
  }

  return {
    handled: true,
    response: `Current working directory: \`${session.workingDir}\``,
  };
}

/**
 * /continue - Show command to continue session in terminal
 */
function handleContinue(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
    };
  }

  const command = `claude --resume ${session.sessionId}`;

  return {
    handled: true,
    blocks: buildTerminalCommandBlocks({
      title: 'Continue in Terminal',
      description: 'Run this command to continue your session locally:',
      command,
      workingDir: session.workingDir,
      sessionId: session.sessionId,
    }),
  };
}

/**
 * /fork - Show command to fork session in terminal
 */
function handleFork(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
    };
  }

  const command = `claude --resume ${session.sessionId} --fork-session`;

  return {
    handled: true,
    blocks: buildTerminalCommandBlocks({
      title: 'Fork to Terminal',
      description: 'Run this command to create a new branch from your session:',
      command,
      workingDir: session.workingDir,
      sessionId: session.sessionId,
      note: 'This creates a new session. The original Slack session remains unchanged.',
    }),
  };
}

/**
 * /resume <session-id> - Resume a terminal session in Slack
 */
function handleResume(sessionId: string): CommandResult {
  if (!sessionId) {
    return {
      handled: true,
      response:
        'Usage: `/resume <session-id>`\n\nGet the session ID from your terminal with `claude --print-session-id`',
    };
  }

  // Validate session ID format (UUID-like: 8-4-4-4-12 hex chars)
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuidPattern.test(sessionId)) {
    return {
      handled: true,
      response: `Invalid session ID format: \`${sessionId}\``,
    };
  }

  return {
    handled: true,
    response: `Resuming session \`${sessionId}\`\n\nYour next message will continue this session.`,
    sessionUpdate: { sessionId },
  };
}

/**
 * /fork-thread [description] - Fork current thread to a new thread
 * Must be used inside a thread. Caller handles the actual forking.
 */
function handleForkThread(description: string): CommandResult {
  // Strip quotes if present
  const cleanDescription = description.replace(/^["']|["']$/g, '').trim();

  return {
    handled: true,
    forkThread: {
      description: cleanDescription || 'Exploring alternative approach',
    },
  };
}
