import fs from 'fs';

/**
 * SDK Permission Mode type - matches @anthropic-ai/claude-code SDK.
 * - 'plan': Read-only mode, writes to plan file via ExitPlanMode tool
 * - 'default': Ask-based mode, prompts for approval on tool use
 * - 'bypassPermissions': Auto mode, runs tools without approval
 * - 'acceptEdits': Accept code edits without prompting
 */
export type PermissionMode = 'plan' | 'default' | 'bypassPermissions' | 'acceptEdits';

/**
 * All available permission modes for UI display.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'default', 'bypassPermissions', 'acceptEdits'];

export interface Session {
  sessionId: string | null;
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (immutable once set)
  pathConfigured: boolean;      // Whether /path has been run
  configuredPath: string | null; // The immutable path
  configuredBy: string | null;   // User ID who set it
  configuredAt: number | null;   // When it was set
}

/**
 * Thread session that is forked from a main session.
 */
export interface ThreadSession {
  sessionId: string | null;
  forkedFrom: string | null;  // Parent session ID
  forkedFromThreadTs?: string;  // Source thread's timestamp (for thread-to-thread forks)
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (inherited from channel)
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
}

/**
 * Channel session data including main session and thread sessions.
 */
interface ChannelSession extends Session {
  threads?: {
    [threadTs: string]: ThreadSession;
  };
}

interface SessionStore {
  channels: {
    [channelId: string]: ChannelSession;
  };
}

const SESSIONS_FILE = './sessions.json';

/**
 * Load sessions from disk. Handles corrupted files gracefully.
 */
export function loadSessions(): SessionStore {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const content = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate basic structure
      if (parsed && typeof parsed === 'object' && parsed.channels) {
        // Migration: Add default path config fields to existing sessions
        for (const channelId in parsed.channels) {
          const channel = parsed.channels[channelId];
          if (channel.pathConfigured === undefined) {
            channel.pathConfigured = false;
            channel.configuredPath = null;
            channel.configuredBy = null;
            channel.configuredAt = null;
          }
          // Migrate threads too
          if (channel.threads) {
            for (const threadTs in channel.threads) {
              const thread = channel.threads[threadTs];
              if (thread.pathConfigured === undefined) {
                thread.pathConfigured = channel.pathConfigured;
                thread.configuredPath = channel.configuredPath;
                thread.configuredBy = channel.configuredBy;
                thread.configuredAt = channel.configuredAt;
              }
            }
          }
        }
        return parsed;
      }
      console.error('sessions.json has invalid structure, resetting');
      return { channels: {} };
    } catch (error) {
      console.error('Failed to parse sessions.json, resetting:', error);
      return { channels: {} };
    }
  }
  return { channels: {} };
}

export function saveSessions(store: SessionStore): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

export function getSession(channelId: string): Session | null {
  const store = loadSessions();
  return store.channels[channelId] || null;
}

export function saveSession(channelId: string, session: Partial<Session>): void {
  const store = loadSessions();
  const existing = store.channels[channelId];

  store.channels[channelId] = {
    sessionId: existing?.sessionId ?? null,
    workingDir: existing?.workingDir ?? process.cwd(),
    mode: existing?.mode ?? 'default',
    createdAt: existing?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: existing?.pathConfigured ?? false,
    configuredPath: existing?.configuredPath ?? null,
    configuredBy: existing?.configuredBy ?? null,
    configuredAt: existing?.configuredAt ?? null,
    threads: existing?.threads,  // Preserve existing threads
    ...session,
  };
  saveSessions(store);
}

// ============================================================================
// Thread Session Management
// ============================================================================

/**
 * Get a thread session if it exists.
 */
export function getThreadSession(
  channelId: string,
  threadTs: string
): ThreadSession | null {
  const store = loadSessions();
  const channel = store.channels[channelId];
  if (!channel?.threads) {
    return null;
  }
  return channel.threads[threadTs] || null;
}

/**
 * Save a thread session.
 */
export function saveThreadSession(
  channelId: string,
  threadTs: string,
  session: Partial<ThreadSession>
): void {
  const store = loadSessions();
  const channel = store.channels[channelId];

  if (!channel) {
    // No main session exists - create a minimal one
    store.channels[channelId] = {
      sessionId: null,
      workingDir: process.cwd(),
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      configuredBy: null,
      configuredAt: null,
      threads: {},
    };
  }

  if (!store.channels[channelId].threads) {
    store.channels[channelId].threads = {};
  }

  const existingThread = store.channels[channelId].threads![threadTs];

  store.channels[channelId].threads![threadTs] = {
    sessionId: existingThread?.sessionId ?? null,
    forkedFrom: existingThread?.forkedFrom ?? null,
    workingDir: existingThread?.workingDir ?? store.channels[channelId].workingDir,
    mode: existingThread?.mode ?? store.channels[channelId].mode,
    createdAt: existingThread?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    // INHERIT path configuration from channel
    pathConfigured: existingThread?.pathConfigured ?? store.channels[channelId].pathConfigured,
    configuredPath: existingThread?.configuredPath ?? store.channels[channelId].configuredPath,
    configuredBy: existingThread?.configuredBy ?? store.channels[channelId].configuredBy,
    configuredAt: existingThread?.configuredAt ?? store.channels[channelId].configuredAt,
    ...session,
  };

  saveSessions(store);
}

/**
 * Result of getting or creating a thread session.
 */
export interface ThreadSessionResult {
  session: ThreadSession;
  isNewFork: boolean;  // True if this is the first message in thread (needs fork)
}

/**
 * Get or create a thread session.
 * If the thread doesn't have a session, returns a new session that should be forked
 * from the main session.
 */
export function getOrCreateThreadSession(
  channelId: string,
  threadTs: string
): ThreadSessionResult {
  const existing = getThreadSession(channelId, threadTs);

  if (existing) {
    return {
      session: existing,
      isNewFork: false,
    };
  }

  // Thread doesn't have a session - create one that will be forked
  const mainSession = getSession(channelId);

  const newThreadSession: ThreadSession = {
    sessionId: null,  // Will be set after SDK creates the forked session
    forkedFrom: mainSession?.sessionId ?? null,
    workingDir: mainSession?.workingDir ?? process.cwd(),
    mode: mainSession?.mode ?? 'default',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    // Inherit path configuration from main session
    pathConfigured: mainSession?.pathConfigured ?? false,
    configuredPath: mainSession?.configuredPath ?? null,
    configuredBy: mainSession?.configuredBy ?? null,
    configuredAt: mainSession?.configuredAt ?? null,
  };

  // Save the new thread session
  saveThreadSession(channelId, threadTs, newThreadSession);

  return {
    session: newThreadSession,
    isNewFork: true,
  };
}
