import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";

import {
  attachCanaryWebSocketEcho,
  CANARY_ECHO_MAX_PENDING_BYTES,
  INITIAL_CANARY_ECHO_STATE,
  transitionCanaryEcho,
} from "./canary-echo.ts";

test("canary echo policy는 한 send만 허용하고 중복 in-flight를 terminate한다", () => {
  const admitted = transitionCanaryEcho(INITIAL_CANARY_ECHO_STATE, {
    type: "RECEIVE",
    byteLength: CANARY_ECHO_MAX_PENDING_BYTES,
  });
  assert.equal(admitted.action, "SEND");
  assert.deepEqual(admitted.state, {
    status: "SENDING",
    pendingBytes: CANARY_ECHO_MAX_PENDING_BYTES,
  });

  const rejected = transitionCanaryEcho(admitted.state, {
    type: "RECEIVE",
    byteLength: 1,
  });
  assert.equal(rejected.action, "TERMINATE");
  assert.deepEqual(rejected.state, { status: "CLOSED", pendingBytes: 0 });
});

test("canary echo policy는 send 완료 뒤 다음 bounded echo를 허용한다", () => {
  const admitted = transitionCanaryEcho(INITIAL_CANARY_ECHO_STATE, {
    type: "RECEIVE",
    byteLength: 8,
  });
  const completed = transitionCanaryEcho(admitted.state, { type: "SEND_COMPLETED" });
  const next = transitionCanaryEcho(completed.state, {
    type: "RECEIVE",
    byteLength: 16,
  });

  assert.deepEqual(completed, {
    state: INITIAL_CANARY_ECHO_STATE,
    action: "NONE",
  });
  assert.equal(next.action, "SEND");
});

test("canary echo fail-close는 listener와 idle timer를 정리한다", async () => {
  const socket = new FakeCanarySocket();
  attachCanaryWebSocketEcho(socket as unknown as WebSocket, 10);

  socket.emit("message", Buffer.alloc(64), true);
  assert.equal(socket.sent.length, 1);
  socket.emit("message", Buffer.alloc(1), true);

  assert.equal(socket.terminateCalls, 1);
  for (const event of ["message", "ping", "pong", "close", "error"]) {
    assert.equal(socket.listenerCount(event), 0, `${event} listener leaked`);
  }
  socket.completeSend();
  await delay(20);
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(socket.terminateCalls, 1);
});

test("canary echo는 WebSocket control ping을 idle activity로 인정하지 않고 종료한다", async () => {
  const socket = new FakeCanarySocket();
  attachCanaryWebSocketEcho(socket as unknown as WebSocket, 10);

  socket.emit("ping", Buffer.alloc(125));

  assert.equal(socket.terminateCalls, 1);
  for (const event of ["message", "ping", "pong", "close", "error"]) {
    assert.equal(socket.listenerCount(event), 0, `${event} listener leaked`);
  }
  await delay(20);
  assert.equal(socket.closeCalls.length, 0);
});

class FakeCanarySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<Readonly<{ data: unknown; binary: boolean }>> = [];
  readonly closeCalls: Array<Readonly<{ code: number; reason: string }>> = [];
  terminateCalls = 0;
  private sendCallback: ((error?: Error) => void) | undefined;

  send(
    data: unknown,
    options: Readonly<{ binary: boolean }>,
    callback: (error?: Error) => void,
  ): void {
    this.sent.push({ data, binary: options.binary });
    this.sendCallback = callback;
  }

  completeSend(error?: Error): void {
    const callback = this.sendCallback;
    this.sendCallback = undefined;
    callback?.(error);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}
