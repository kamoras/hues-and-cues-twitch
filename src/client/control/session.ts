import { storage } from '../common/storage.js';

const STORAGE_KEY = 'hues-and-cues:host-session';

export interface HostSession {
  readonly roomId: string;
  readonly hostToken: string;
  readonly channel: string;
}

function isHostSession(value: unknown): value is HostSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.roomId === 'string' &&
    typeof record.hostToken === 'string' &&
    typeof record.channel === 'string'
  );
}

export function loadSession(): HostSession | null {
  const raw = storage.get(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHostSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: HostSession): void {
  storage.set(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  storage.remove(STORAGE_KEY);
}

export function overlayUrl(session: Pick<HostSession, 'roomId'>): string {
  const url = new URL('/overlay', window.location.origin);
  url.searchParams.set('room', session.roomId);
  return url.toString();
}
