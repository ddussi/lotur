import type { ReviewContext } from "./contracts.ts";

type Draft = Readonly<{ text: string; version: number; data?: unknown }>;
type Submission = Draft & Readonly<{ key: string; scope: string | undefined }>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const PREFIX = "review-tunnel:drafts:v1:";
const TTL_MS = 12 * 60 * 60_000;
const MAX_ENTRIES = 40;
const MAX_SERIALIZED_LENGTH = 250_000;

export function reviewDraftScope(context: ReviewContext): string | undefined {
  if (!context.draftSession) return undefined;
  return JSON.stringify([context.draftSession, context.principal.accountId, context.project.id, context.revision.id]);
}

function browserStorage(): DraftStorage | undefined {
  try { return sessionStorage; } catch { return undefined; }
}

export function createDraftStore(options: { channel?: string; storage?: DraftStorage; now?: () => number } = {}) {
  const storage = options.storage ?? browserStorage();
  const now = options.now ?? Date.now;
  const drafts = new Map<string, Draft>();
  const key = (path: string, threadId: string) => JSON.stringify([path, threadId]);
  let scope: string | undefined;
  let storageKey: string | undefined;
  let version = 0;
  const persist = () => {
    if (!storage || !storageKey) return;
    try {
      while (drafts.size > MAX_ENTRIES) drafts.delete(drafts.keys().next().value!);
      if (!drafts.size) { storage.removeItem(storageKey); return; }
      let value = JSON.stringify({ expiresAt: now() + TTL_MS, entries: [...drafts] });
      while (value.length > MAX_SERIALIZED_LENGTH && drafts.size) {
        drafts.delete(drafts.keys().next().value!);
        value = JSON.stringify({ expiresAt: now() + TTL_MS, entries: [...drafts] });
      }
      storage.setItem(storageKey, value);
    } catch {
      // A blocked/full browser store must not break writing or resurrect an older saved draft.
      try { storage.removeItem(storageKey); } catch {}
    }
  };
  return {
    setScope(next: string | undefined): boolean {
      if (scope === next) return false;
      scope = next;
      drafts.clear();
      storageKey = next === undefined ? undefined : PREFIX + JSON.stringify([next, options.channel ?? "comments"]);
      if (!storage || !storageKey) return true;
      try {
        const session = JSON.parse(next!)[0];
        const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((value): value is string => value?.startsWith(PREFIX) === true);
        for (const candidate of keys) {
          try {
            const [savedScope] = JSON.parse(candidate.slice(PREFIX.length));
            const value = storage.getItem(candidate);
            if (JSON.parse(savedScope)[0] !== session || !value || value.length > MAX_SERIALIZED_LENGTH || JSON.parse(value).expiresAt <= now()) storage.removeItem(candidate);
          } catch { storage.removeItem(candidate); }
        }
        for (const candidate of keys.filter(value => value !== storageKey).slice(0, Math.max(0, keys.length - 20))) storage.removeItem(candidate);
        const raw = storage.getItem(storageKey);
        if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return true;
        const saved: unknown = JSON.parse(raw);
        if (!saved || typeof saved !== "object" || !("expiresAt" in saved) || typeof saved.expiresAt !== "number" || saved.expiresAt <= now() || !("entries" in saved) || !Array.isArray(saved.entries)) throw new Error("invalid drafts");
        for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [id, draft] = entry;
          if (typeof id !== "string" || id.length > 5000 || !draft || typeof draft.text !== "string" || draft.text.length > 4000 || !Number.isSafeInteger(draft.version) || draft.version < 1) continue;
          drafts.set(id, { text: draft.text, version: ++version, ...(draft.data === undefined ? {} : { data: draft.data }) });
        }
      } catch { try { storage.removeItem(storageKey); } catch {} }
      return true;
    },
    get(path: string, threadId: string): Draft | undefined { return drafts.get(key(path, threadId)); },
    read(path: string, threadId: string): string { return drafts.get(key(path, threadId))?.text ?? ""; },
    write(path: string, threadId: string, text: string, data?: unknown): void {
      const id = key(path, threadId);
      drafts.delete(id);
      if (text !== "" || data !== undefined) drafts.set(id, { text: text.slice(0, 4000), version: ++version, ...(data === undefined ? {} : { data }) });
      persist();
    },
    capture(path: string, threadId: string): Submission {
      const id = key(path, threadId);
      return { key: id, scope, ...(drafts.get(id) ?? { text: "", version: 0 }) };
    },
    acknowledge(submitted: Submission): boolean {
      if (submitted.scope !== scope || drafts.get(submitted.key)?.version !== submitted.version) return false;
      drafts.delete(submitted.key);
      persist();
      return true;
    },
    remove(path: string, threadId: string): void { drafts.delete(key(path, threadId)); persist(); },
    clear(): void {
      drafts.clear();
      // Access denial also clears drafts from other routes/revisions in this origin.
      try {
        if (storage) for (const name of Array.from({ length: storage.length }, (_, i) => storage.key(i))) {
          if (name?.startsWith(PREFIX)) storage.removeItem(name);
        }
      } catch {}
    },
    dispose(): void { drafts.clear(); },
  };
}
