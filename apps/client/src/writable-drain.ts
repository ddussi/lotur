type DrainTarget = Pick<NodeJS.EventEmitter, "once" | "off">;

export function waitForWritableDrain(target: DrainTarget): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("close", onClose);
      target.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("writable closed before drain"));
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    target.once("drain", onDrain);
    target.once("close", onClose);
    target.once("error", onError);
  });
}
