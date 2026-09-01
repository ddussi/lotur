import { REVIEW_API } from "./api.ts";

export function createLiveUpdates(callbacks: {
  changed(): void;
  reset(): void;
  failed(message: string): void;
}) {
  let source: EventSource | undefined;
  let path: string | undefined;
  const close = () => {
    source?.close();
    source = undefined;
    path = undefined;
  };
  return {
    close,
    open(nextPath: string, cursor: string): void {
      if (source !== undefined && path === nextPath) return;
      close();
      path = nextPath;
      const current = new EventSource(
        `${REVIEW_API}/events?path=${encodeURIComponent(nextPath)}&after=${encodeURIComponent(cursor)}`,
      );
      source = current;
      current.addEventListener("review", () => {
        if (source === current) callbacks.changed();
      });
      current.addEventListener("review-error", (event) => {
        if (source !== current) return;
        let code = "REVIEW_UNAVAILABLE";
        try {
          const value: unknown = JSON.parse((event as MessageEvent<string>).data);
          if (
            typeof value === "object" &&
            value !== null &&
            "error" in value &&
            typeof value.error === "string"
          )
            code = value.error;
        } catch {
          code = "INVALID_REVIEW_EVENT";
        }
        close();
        if (code === "REVIEW_CURSOR_EXPIRED") callbacks.reset();
        else callbacks.failed(code);
      });
    },
  };
}

export function watchNavigation(changed: () => void, signal: AbortSignal): void {
  const eventName = "review-tunnel:navigation";
  const cleanups: Array<() => void> = [];
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    const wrapped: History[typeof name] = function (this: History, ...args) {
      original.apply(this, args);
      window.dispatchEvent(new Event(eventName));
    };
    history[name] = wrapped;
    cleanups.push(() => {
      if (history[name] === wrapped) history[name] = original;
    });
  }
  window.addEventListener(eventName, changed, { signal });
  window.addEventListener("popstate", changed, { signal });
  signal.addEventListener(
    "abort",
    () => {
      for (const cleanup of cleanups) cleanup();
    },
    { once: true },
  );
}
