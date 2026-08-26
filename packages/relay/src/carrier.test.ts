import assert from "node:assert/strict";
import test from "node:test";

import { FrameType } from "../../protocol/src/envelope.ts";
import {
  MAX_CARRIER_BUFFERED_BYTES,
  sendCarrierFrame,
} from "./carrier.ts";

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
