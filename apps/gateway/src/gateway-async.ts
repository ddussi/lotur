export const CONNECTION_ABORTED = Symbol("connection-aborted");

export class PromiseDeadlineError extends Error {}

export function settleWhileConnected<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof CONNECTION_ABORTED> {
  if (signal.aborted) return Promise.resolve(CONNECTION_ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => resolve(CONNECTION_ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(signal.aborted ? CONNECTION_ABORTED : value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function withPromiseDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PromiseDeadlineError(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function toSafeErrorReason(value: unknown): string {
  const message = value instanceof Error ? value.message : "unknown carrier failure";
  return message.replace(/[\r\n]/g, " ").slice(0, 160);
}
