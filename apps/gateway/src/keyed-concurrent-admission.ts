export function createKeyedConcurrentAdmission(input: Readonly<{
  global: number;
  perKey: number;
}>): Readonly<{ acquire(key: string): (() => void) | undefined }> {
  let concurrent = 0;
  const concurrentByKey = new Map<string, number>();
  return {
    acquire(key) {
      const keyedConcurrent = concurrentByKey.get(key) ?? 0;
      if (concurrent >= input.global || keyedConcurrent >= input.perKey) return undefined;
      concurrent += 1;
      concurrentByKey.set(key, keyedConcurrent + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        concurrent -= 1;
        const remaining = (concurrentByKey.get(key) ?? 1) - 1;
        if (remaining === 0) concurrentByKey.delete(key);
        else concurrentByKey.set(key, remaining);
      };
    },
  };
}
