import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  readIncrementalSseFirstEvent,
  waitForWebSocketEvent,
  withRequestDeadline,
} from "./canary-policy.mjs";

const encoder = new TextEncoder();

test("SSE first event는 첫 marker만 포함할 때 streaming으로 인정한다", async () => {
  await readIncrementalSseFirstEvent(
    readerOf("data: canary-first\n\n"),
    "canary-first",
    "canary-second",
  );
});

test("SSE first event와 두 번째 marker가 함께 오면 buffering으로 거부한다", async () => {
  await assert.rejects(
    readIncrementalSseFirstEvent(
      readerOf("data: canary-first\n\ndata: canary-second\n\n"),
      "canary-first",
      "canary-second",
    ),
    /buffered beyond the first SSE event/,
  );
});

test("SSE marker가 여러 transport chunk로 나뉘어도 첫 event를 조립한다", async () => {
  await readIncrementalSseFirstEvent(
    readerOf("data: canary-fi", "rst\n", "\n"),
    "canary-first",
    "canary-second",
  );
});

test("SSE first event가 종료되거나 marker가 없으면 거부한다", async () => {
  await assert.rejects(
    readIncrementalSseFirstEvent(
      readerOf(),
      "canary-first",
      "canary-second",
    ),
    /first event marker mismatch/,
  );
});

test("SSE first event 조립은 byte 상한을 넘으면 거부한다", async () => {
  await assert.rejects(
    readIncrementalSseFirstEvent(
      readerOf(`data: ${"x".repeat(64)}`),
      "canary-first",
      "canary-second",
      32,
    ),
    /exceeded 32 bytes/,
  );
});

test("canary HTTP request signal은 peer가 멈춰도 deadline에 abort된다", async () => {
  const init = withRequestDeadline({ headers: { accept: "text/html" } }, 10);

  assert.equal(init.headers.accept, "text/html");
  await new Promise((resolve) => init.signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(init.signal.aborted, true);
});

test("caller cancellation과 canary deadline을 모두 보존한다", () => {
  const caller = new AbortController();
  const init = withRequestDeadline({ signal: caller.signal }, 60_000);

  caller.abort(new Error("deployment cancelled"));
  assert.equal(init.signal.aborted, true);
});

test("WebSocket timeout은 terminate error를 관찰하고 listener를 정리한다", async () => {
  class SilentSocket extends EventEmitter {
    terminate() {
      queueMicrotask(() => {
        this.emit("error", new Error("closed before handshake"));
        this.emit("close");
      });
    }
  }
  const socket = new SilentSocket();

  await assert.rejects(
    waitForWebSocketEvent(socket, "open", 10),
    /WebSocket open timed out/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

function readerOf(...chunks) {
  const values = chunks.map((chunk) => encoder.encode(chunk));
  return {
    async read() {
      const value = values.shift();
      return value === undefined
        ? { done: true, value: undefined }
        : { done: false, value };
    },
  };
}
