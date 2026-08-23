import { spawn } from "node:child_process";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

export function createSignalAwareCommandRunner(input = {}) {
  const spawnChild = input.spawnChild ?? spawn;
  const signalSource = input.signalSource ?? process;
  let activeChild;
  let interruptedSignal;
  let disposed = false;
  const handlers = new Map();

  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      interruptedSignal ??= signal;
      try {
        activeChild?.kill(signal);
      } catch {
        // The child may have exited between observing it and forwarding the signal.
      }
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  const assertNotInterrupted = () => {
    if (interruptedSignal !== undefined) {
      throw new Error(`operation interrupted by ${interruptedSignal}`);
    }
  };

  return {
    assertNotInterrupted,
    async run(command, arguments_, options) {
      assertNotInterrupted();
      const child = spawnChild(command, arguments_, options);
      activeChild = child;
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const settle = (operation) => {
            if (settled) return;
            settled = true;
            child.off("error", onError);
            child.off("exit", onExit);
            operation();
          };
          const clearActiveChild = () => {
            if (activeChild === child) activeChild = undefined;
          };
          const onError = (error) => settle(() => {
            clearActiveChild();
            reject(error);
          });
          const onExit = (code, signal) => settle(() => {
            clearActiveChild();
            if (code === 0) resolve();
            else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
          });
          child.once("error", onError);
          child.once("exit", onExit);
          if (interruptedSignal !== undefined) {
            try {
              child.kill(interruptedSignal);
            } catch {
              // The normal child error/exit event settles the operation.
            }
          }
        });
      } finally {
        if (activeChild === child) activeChild = undefined;
      }
      assertNotInterrupted();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [signal, handler] of handlers) signalSource.off(signal, handler);
    },
  };
}
