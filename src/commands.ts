/**
 * Command parser and handlers for slash commands.
 * Commands are prefixed with `/` (e.g., /status, /mode, /continue)
 */

import fs from 'fs';
import path from 'path';
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
  // For /wait command - rate limit stress test
  waitTest?: {
    seconds: number;
  };
  // For /model command - triggers model selection UI (async fetch in handler)
  showModelSelection?: boolean;
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
    case 'set-current-path':
      return handleSetCurrentPath(session);
    case 'cd':
      return handleCd(argString, session);
    case 'ls':
      return handleLs(argString, session);
    case 'continue':
      return handleContinue(session);
    case 'fork':
      return handleFork(session);
    case 'fork-thread':
      return handleForkThread(argString);
    case 'resume':
      return handleResume(argString);
    case 'wait':
      return handleWait(argString);
    case 'model':
      return handleModel(argString);
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
\`/ls [path]\` - List files in directory (relative or absolute)
\`/cd [path]\` - Change directory (only before path locked)
\`/set-current-path\` - Lock current directory (one-time only)
\`/status\` - Show session info (ID, mode, directory)
\`/mode\` - Show mode picker
\`/model\` - Show model picker
\`/continue\` - Get command to continue session in terminal
\`/fork\` - Get command to fork session to terminal
\`/fork-thread [desc]\` - Fork current thread to new thread
\`/resume <id>\` - Resume a terminal session in Slack
\`/wait <sec>\` - Rate limit test (1-300 seconds)`;

  return {
    handled: true,
    response: helpText,
  };
}

/**
 * /set-current-path - Lock current working directory (one-time only)
 */
function handleSetCurrentPath(session: Session): CommandResult {
  // Check if path already configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ Working directory already locked: \`${session.configuredPath}\`\n\nThis cannot be changed. If you need a different directory, use a different channel.`,
    };
  }

  // Use current working directory
  const currentPath = session.workingDir;

  // Normalize path (resolve symlinks, remove trailing slash)
  const normalizedPath = fs.realpathSync(currentPath);

  return {
    handled: true,
    response: `✅ Working directory locked to \`${normalizedPath}\`\n\n⚠️ This cannot be changed. \`/cd\` is now disabled. All Claude Code operations will use this directory.`,
    sessionUpdate: {
      pathConfigured: true,
      configuredPath: normalizedPath,
      workingDir: normalizedPath,
      configuredAt: Date.now(),
    },
  };
}

/**
 * /cd [path] - Change working directory (only before path locked)
 * Accepts relative or absolute paths
 */
function handleCd(pathArg: string, session: Session): CommandResult {
  // Check if path already configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ \`/cd\` is disabled after path locked.\n\nWorking directory is locked to: \`${session.configuredPath}\`\n\nUse \`/ls [path]\` to explore other directories.`,
    };
  }

  // If no path provided, show current directory
  if (!pathArg) {
    return {
      handled: true,
      response: `Current directory: \`${session.workingDir}\`\n\nUsage: \`/cd <path>\` (relative or absolute)\n\nTo lock this directory: \`/set-current-path\``,
    };
  }

  // Resolve path (handle both relative and absolute)
  let targetPath: string;

  if (pathArg.startsWith('/')) {
    // Absolute path
    targetPath = pathArg;
  } else {
    // Relative path
    targetPath = path.resolve(session.workingDir, pathArg);
  }

  // Validate: path exists
  if (!fs.existsSync(targetPath)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetPath}\``,
    };
  }

  // Check if it's a directory (not a file)
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return {
      handled: true,
      response: `❌ Not a directory: \`${targetPath}\``,
    };
  }

  // Check read/execute permissions
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access directory: \`${targetPath}\`\n\nPermission denied or directory not readable.`,
    };
  }

  // Normalize path (resolve symlinks)
  const normalizedPath = fs.realpathSync(targetPath);

  return {
    handled: true,
    response: `📂 Changed to \`${normalizedPath}\`\n\nUse \`/ls\` to see files, or \`/set-current-path\` to lock this directory.`,
    sessionUpdate: {
      workingDir: normalizedPath,
    },
  };
}

/**
 * /ls [path] - List files in directory
 * Accepts relative or absolute paths. Always available.
 */
function handleLs(pathArg: string, session: Session): CommandResult {
  // Determine which directory to list
  let targetDir: string;
  if (!pathArg) {
    targetDir = session.workingDir;
  } else if (pathArg.startsWith('/')) {
    // Absolute path
    targetDir = pathArg;
  } else {
    // Relative path
    targetDir = path.resolve(session.workingDir, pathArg);
  }

  // Validate path exists
  if (!fs.existsSync(targetDir)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetDir}\``,
    };
  }

  // Check if it's a directory
  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      return {
        handled: true,
        response: `❌ Not a directory: \`${targetDir}\``,
      };
    }
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access: \`${targetDir}\`\n\n${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const files = fs.readdirSync(targetDir);
    const totalFiles = files.length;

    // Show all files
    const fileList = files.join('\n');

    // Generate hint based on whether path is locked
    let hint: string;
    if (session.pathConfigured) {
      hint = `Current locked directory: \`${session.configuredPath}\``;
    } else {
      hint = `To navigate: \`/cd ${targetDir}\`\nTo lock directory: \`/set-current-path\``;
    }

    return {
      handled: true,
      response: `Files in \`${targetDir}\` (${totalFiles} total):\n\`\`\`\n${fileList}\n\`\`\`\n\n${hint}`,
    };
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
      pathConfigured: session.pathConfigured,
      configuredBy: session.configuredBy,
      configuredAt: session.configuredAt,
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

/**
 * /wait <seconds> - Rate limit stress test
 * Updates spinner for X seconds to test Slack API limits
 */
function handleWait(secondsArg: string): CommandResult {
  const seconds = parseInt(secondsArg, 10);

  if (isNaN(seconds) || seconds < 1 || seconds > 300) {
    return {
      handled: true,
      response:
        'Usage: `/wait <seconds>` (1-300)\n\nThis command tests Slack rate limits by updating the spinner every second for X seconds.',
    };
  }

  return {
    handled: true,
    waitTest: { seconds },
  };
}

/**
 * /model - Show model picker
 * Model list is fetched dynamically from SDK in slack-bot.ts handler.
 */
function handleModel(modelArg: string): CommandResult {
  if (modelArg) {
    // User tried to type a model directly - redirect to selection UI
    return {
      handled: true,
      response: 'Please use the model picker to select a model.',
      showModelSelection: true,
    };
  }

  // Return flag - actual blocks built async in slack-bot.ts
  return {
    handled: true,
    showModelSelection: true,
  };
}
