import fs from 'fs';

export interface Session {
  sessionId: string | null;
  workingDir: string;
  mode: 'plan' | 'auto' | 'ask';
  createdAt: number;
  lastActiveAt: number;
}

interface SessionStore {
  channels: {
    [channelId: string]: Session;
  };
}

const SESSIONS_FILE = './sessions.json';

export function loadSessions(): SessionStore {
  if (fs.existsSync(SESSIONS_FILE)) {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
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
    mode: existing?.mode ?? 'plan',
    createdAt: existing?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    ...session,
  };
  saveSessions(store);
}
