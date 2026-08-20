import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeDecodeError,
  FrameType,
  PROTOCOL_VERSION,
} from "./envelope.ts";

test("binary payload를 손실 없이 envelope로 왕복한다", () => {
  const payload = Uint8Array.from([0, 1, 127, 128, 255]);

  const encoded = encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: 7,
    streamId: 42,
    payload,
  });

  assert.deepEqual(decodeEnvelope(encoded), {
    version: PROTOCOL_VERSION,
    type: FrameType.Data,
    flags: 0,
    generation: 7,
    streamId: 42,
    payload,
  });
});

test("선언한 payload 길이와 실제 길이가 다르면 거부한다", () => {
  const encoded = encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: 1,
    streamId: 1,
    payload: Uint8Array.from([1, 2, 3]),
  });
  const truncated = encoded.subarray(0, encoded.byteLength - 1);

  assert.throws(
    () => decodeEnvelope(truncated),
    (error: unknown) =>
      error instanceof EnvelopeDecodeError && error.code === "LENGTH_MISMATCH",
  );
});

test("지원하지 않는 protocol version을 거부한다", () => {
  const encoded = encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: new Uint8Array(),
  });
  encoded[2] = PROTOCOL_VERSION + 1;

  assert.throws(
    () => decodeEnvelope(encoded),
    (error: unknown) =>
      error instanceof EnvelopeDecodeError && error.code === "VERSION_UNSUPPORTED",
  );
});

test("control frame은 stream 0, data frame은 양수 stream ID만 허용한다", () => {
  assert.throws(() =>
    encodeEnvelope({
      type: FrameType.Ping,
      flags: 0,
      generation: 1,
      streamId: 9,
      payload: new Uint8Array(),
    }),
  );

  assert.throws(() =>
    encodeEnvelope({
      type: FrameType.Data,
      flags: 0,
      generation: 1,
      streamId: 0,
      payload: new Uint8Array(),
    }),
  );
});

test("잘못된 magic과 알 수 없는 frame type을 fail-closed한다", () => {
  const wrongMagic = encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: new Uint8Array(),
  });
  wrongMagic[0] = 0;
  assert.throws(
    () => decodeEnvelope(wrongMagic),
    (error: unknown) =>
      error instanceof EnvelopeDecodeError && error.code === "MAGIC_INVALID",
  );

  const unknownType = encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: new Uint8Array(),
  });
  unknownType[3] = 255;
  assert.throws(
    () => decodeEnvelope(unknownType),
    (error: unknown) =>
      error instanceof EnvelopeDecodeError && error.code === "FRAME_TYPE_UNKNOWN",
  );
});

test("uint16 envelope 상한보다 큰 payload는 encode 전에 거부한다", () => {
  assert.throws(() =>
    encodeEnvelope({
      type: FrameType.Data,
      flags: 0,
      generation: 1,
      streamId: 1,
      payload: new Uint8Array(65_536),
    }),
  );
});
