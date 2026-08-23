const MAGIC = Uint8Array.from([0x52, 0x54]);
const HEADER_BYTES = 16;

export const PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_PAYLOAD_BYTES = 0xffff;

export const FrameType = {
  Ping: 1,
  Pong: 2,
  Hello: 3,
  SessionProvisioned: 4,
  SessionConfig: 5,
  ConfigApplied: 6,
  SessionActive: 7,
  OpenProbe: 8,
  ConnectionError: 9,
  OpenHttp: 10,
  ResponseHeaders: 11,
  Data: 12,
  EndStream: 13,
  WindowUpdate: 14,
  ResetStream: 15,
  CloseSession: 20,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

const CONTROL_FRAME_TYPES = new Set<FrameTypeValue>([
  FrameType.Ping,
  FrameType.Pong,
  FrameType.Hello,
  FrameType.SessionProvisioned,
  FrameType.SessionConfig,
  FrameType.ConfigApplied,
  FrameType.SessionActive,
  FrameType.ConnectionError,
  FrameType.CloseSession,
]);
const EMPTY_PAYLOAD_FRAME_TYPES = new Set<FrameTypeValue>([
  FrameType.Ping,
  FrameType.Pong,
  FrameType.EndStream,
  FrameType.CloseSession,
]);

export type EnvelopeInput = Readonly<{
  type: FrameTypeValue;
  flags: number;
  generation: number;
  streamId: number;
  payload: Uint8Array;
}>;

export type Envelope = EnvelopeInput &
  Readonly<{
    version: number;
  }>;

export type EnvelopeDecodeErrorCode =
  | "FRAME_TOO_SHORT"
  | "MAGIC_INVALID"
  | "VERSION_UNSUPPORTED"
  | "FRAME_TYPE_UNKNOWN"
  | "FLAGS_UNSUPPORTED"
  | "RESERVED_NONZERO"
  | "LENGTH_MISMATCH"
  | "PAYLOAD_UNEXPECTED"
  | "STREAM_ID_INVALID";

export class EnvelopeDecodeError extends Error {
  readonly code: EnvelopeDecodeErrorCode;

  constructor(
    code: EnvelopeDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeDecodeError";
    this.code = code;
  }
}

export function encodeEnvelope(input: EnvelopeInput): Uint8Array {
  assertUnsignedByte(input.flags, "flags");
  if (input.flags !== 0) {
    throw new RangeError("protocol v1 does not define envelope flags");
  }
  assertUint32(input.generation, "generation");
  assertUint32(input.streamId, "streamId");
  assertStreamId(input.type, input.streamId);
  if (EMPTY_PAYLOAD_FRAME_TYPES.has(input.type) && input.payload.byteLength !== 0) {
    throw new RangeError("protocol v1 frame type requires an empty payload");
  }
  if (input.payload.byteLength > MAX_ENVELOPE_PAYLOAD_BYTES) {
    throw new RangeError(
      `payload exceeds ${MAX_ENVELOPE_PAYLOAD_BYTES} byte envelope limit`,
    );
  }

  const output = new Uint8Array(HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  output.set(MAGIC, 0);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, input.type);
  view.setUint8(4, input.flags);
  view.setUint8(5, 0);
  view.setUint32(6, input.generation);
  view.setUint32(10, input.streamId);
  view.setUint16(14, input.payload.byteLength);
  output.set(input.payload, HEADER_BYTES);
  return output;
}

export function decodeEnvelope(input: Uint8Array): Envelope {
  if (input.byteLength < HEADER_BYTES) {
    throw new EnvelopeDecodeError("FRAME_TOO_SHORT", "frame header is incomplete");
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint8(0) !== MAGIC[0] || view.getUint8(1) !== MAGIC[1]) {
    throw new EnvelopeDecodeError("MAGIC_INVALID", "frame magic does not match");
  }

  const version = view.getUint8(2);
  if (version !== PROTOCOL_VERSION) {
    throw new EnvelopeDecodeError(
      "VERSION_UNSUPPORTED",
      `unsupported protocol version: ${version}`,
    );
  }

  const type = view.getUint8(3) as FrameTypeValue;
  if (!Object.values(FrameType).includes(type)) {
    throw new EnvelopeDecodeError("FRAME_TYPE_UNKNOWN", `unknown frame type: ${type}`);
  }

  const flags = view.getUint8(4);
  if (flags !== 0) {
    throw new EnvelopeDecodeError(
      "FLAGS_UNSUPPORTED",
      `protocol v1 does not support envelope flags: ${flags}`,
    );
  }
  const reserved = view.getUint8(5);
  if (reserved !== 0) {
    throw new EnvelopeDecodeError(
      "RESERVED_NONZERO",
      "protocol v1 reserved byte must be zero",
    );
  }
  const generation = view.getUint32(6);
  const streamId = view.getUint32(10);
  const payloadLength = view.getUint16(14);

  if (input.byteLength !== HEADER_BYTES + payloadLength) {
    throw new EnvelopeDecodeError(
      "LENGTH_MISMATCH",
      `declared ${payloadLength} payload bytes, received ${input.byteLength - HEADER_BYTES}`,
    );
  }

  try {
    assertStreamId(type, streamId);
  } catch (error) {
    throw new EnvelopeDecodeError(
      "STREAM_ID_INVALID",
      error instanceof Error ? error.message : "invalid stream ID",
    );
  }
  if (EMPTY_PAYLOAD_FRAME_TYPES.has(type) && payloadLength !== 0) {
    throw new EnvelopeDecodeError(
      "PAYLOAD_UNEXPECTED",
      "protocol v1 frame type requires an empty payload",
    );
  }

  return {
    version,
    type,
    flags,
    generation,
    streamId,
    payload: input.slice(HEADER_BYTES),
  };
}

function assertStreamId(type: FrameTypeValue, streamId: number): void {
  const isControlFrame = CONTROL_FRAME_TYPES.has(type);
  if (isControlFrame && streamId !== 0) {
    throw new RangeError("control frame must use stream ID 0");
  }
  if (!isControlFrame && streamId === 0) {
    throw new RangeError("stream frame must use a positive stream ID");
  }
}

function assertUnsignedByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an unsigned byte`);
  }
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}
