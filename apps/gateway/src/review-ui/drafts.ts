type Draft = Readonly<{ text: string; version: number }>;
type Submission = Draft & Readonly<{ key: string }>;

export function createDraftStore() {
  const drafts = new Map<string, Draft>();
  const key = (path: string, threadId: string) => JSON.stringify([path, threadId]);
  let version = 0;
  return {
    read(path: string, threadId: string): string {
      return drafts.get(key(path, threadId))?.text ?? "";
    },
    write(path: string, threadId: string, text: string): void {
      drafts.set(key(path, threadId), { text, version: ++version });
    },
    capture(path: string, threadId: string): Submission {
      const id = key(path, threadId);
      return { key: id, ...(drafts.get(id) ?? { text: "", version: 0 }) };
    },
    acknowledge(submitted: Submission): boolean {
      if (drafts.get(submitted.key)?.version !== submitted.version) return false;
      drafts.delete(submitted.key);
      return true;
    },
    clear(): void {
      drafts.clear();
    },
  };
}
