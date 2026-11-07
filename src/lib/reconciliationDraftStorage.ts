import type { Draft } from '@/lib/apsReconciliation';

export type DraftStorageMode = 'local' | 'session' | 'memory';
type Drafts = Record<string, Draft>;

function parseDrafts(raw: string | null): Drafts {
  if (raw === null) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const result: Drafts = {};
    for (const [id, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const d = value as Draft;
      if (
        typeof d.version === 'string' &&
        /^\d+$/.test(d.version) &&
        typeof d.monthlyInbound === 'string' &&
        typeof d.monthlyOutbound === 'string' &&
        typeof d.ytdInbound === 'string' &&
        typeof d.ytdOutbound === 'string' &&
        typeof d.opening === 'string' &&
        typeof d.manual === 'boolean'
      )
        result[id] = d;
    }
    return result;
  } catch {
    return {};
  }
}

/** Per-page draft store. Session fallback shadows stale local data after a write failure. */
export function createDraftStorage(key: string) {
  const fallbackKey = `${key}:session-fallback`;
  let mode: DraftStorageMode = 'local';
  let initial: Drafts = {};
  let fallback: string | null = null;
  let sessionReadable = false;
  try {
    fallback = window.sessionStorage.getItem(fallbackKey);
    sessionReadable = true;
  } catch {
    /* Try local storage. */
  }
  if (fallback !== null) {
    mode = 'session';
    initial = parseDrafts(fallback);
  } else {
    try {
      initial = parseDrafts(window.localStorage.getItem(key));
    } catch {
      mode = sessionReadable ? 'session' : 'memory';
    }
  }
  const listeners = new Set<() => void>();
  function changeMode(next: DraftStorageMode) {
    if (mode !== next) {
      mode = next;
      listeners.forEach((listener) => listener());
    }
  }
  return {
    initial,
    getMode: () => mode,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    persist(drafts: Drafts) {
      const value = JSON.stringify(drafts);
      if (mode === 'local') {
        try {
          if (Object.keys(drafts).length) window.localStorage.setItem(key, value);
          else window.localStorage.removeItem(key);
          return;
        } catch {
          changeMode('session');
        }
      }
      if (mode === 'session') {
        try {
          // A store that cannot be read cannot safely restore a draft.
          window.sessionStorage.getItem(fallbackKey);
          // Keep an empty tombstone so stale local values do not reappear after confirmation.
          window.sessionStorage.setItem(fallbackKey, value);
          return;
        } catch {
          changeMode('memory');
        }
      }
      // React state is the in-memory copy. It is never cleared on a storage error.
    },
  };
}
