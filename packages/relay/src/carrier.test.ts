import assert from "node:assert/strict";
import test from "node:test";

import { decodeEnvelope, FrameType } from "../../protocol/src/envelope.ts";
import {
  MAX_CARRIER_BUFFERED_BYTES,
  MAX_DATA_CHUNK_BYTES,
  sendCarrierFrame,
  sendDataChunks,
} from "./carrier.ts";

test("큰 DATA payload를 bounded frame으로 나눈다", async () => {
  const frames: Uint8Array[] = [];
  await sendDataChunks(
    {
      readyState: 1,
      bufferedAmount: 0,
      send(data, callback) {
        frames.push(data);
        callback();
      },
    },
    {
      generation: 3,
      streamId: 9,
      chunk: new Uint8Array(MAX_DATA_CHUNK_BYTES * 2 + 1),
    },
  );

  assert.deepEqual(
    frames.map((frame) => decodeEnvelope(frame).payload.byteLength),
    [MAX_DATA_CHUNK_BYTES, MAX_DATA_CHUNK_BYTES, 1],
  );
  assert.ok(frames.every((frame) => decodeEnvelope(frame).type === FrameType.Data));
});

test("닫힌 Carrier와 pending byte 상한 초과를 전송 전에 거부한다", async () => {
  const input = {
    type: FrameType.Ping,
    generation: 1,
    streamId: 0,
  } as const;
  await assert.rejects(() =>
    sendCarrierFrame(
      {
        readyState: 3,
        bufferedAmount: 0,
        send() {
          throw new Error("must not send");
        },
      },
      input,
    ),
  );
  await assert.rejects(() =>
    sendCarrierFrame(
      {
        readyState: 1,
        bufferedAmount: MAX_CARRIER_BUFFERED_BYTES,
        send() {
          throw new Error("must not send");
        },
      },
      input,
    ),
  );
});
