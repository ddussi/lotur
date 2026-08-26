import {
  encodeEnvelope,
  FrameType,
  type FrameTypeValue,
} from "../../protocol/src/envelope.ts";
import { OutboundFlowWindow } from "./flow-window.ts";

export const MAX_DATA_CHUNK_BYTES = 32 * 1024;
export const MAX_CARRIER_BUFFERED_BYTES = 1024 * 1024;
export const INITIAL_STREAM_WINDOW_BYTES = 64 * 1024;
export const INITIAL_CONNECTION_WINDOW_BYTES = 256 * 1024;

export type CarrierSocket = Readonly<{
  readyState: number;
  bufferedAmount: number;
  send(
    data: Uint8Array,
    callback: (error?: Error) => void,
  ): void;
}>;

export async function sendCarrierFrame(
  socket: CarrierSocket,
  input: Readonly<{
    type: FrameTypeValue;
    flags?: number;
    generation: number;
    streamId: number;
    payload?: Uint8Array;
  }>,
): Promise<void> {
  if (socket.readyState !== 1) {
    throw new Error("Carrier is not open");
  }

  const encoded = encodeEnvelope({
    type: input.type,
    flags: input.flags ?? 0,
    generation: input.generation,
    streamId: input.streamId,
    payload: input.payload ?? new Uint8Array(),
  });
  if (socket.bufferedAmount + encoded.byteLength > MAX_CARRIER_BUFFERED_BYTES) {
    throw new Error("Carrier buffered byte limit exceeded");
  }

  await new Promise<void>((resolve, reject) => {
    socket.send(encoded, (error) => (error == null ? resolve() : reject(error)));
  });
}

export async function sendFlowControlledData(
  socket: CarrierSocket,
  window: OutboundFlowWindow,
  input: Readonly<{
    generation: number;
    streamId: number;
    chunk: Uint8Array;
  }>,
): Promise<void> {
  let offset = 0;
  while (offset < input.chunk.byteLength) {
    const bytes = await window.take(
      input.streamId,
      Math.min(MAX_DATA_CHUNK_BYTES, input.chunk.byteLength - offset),
    );
    await sendCarrierFrame(socket, {
      type: FrameType.Data,
      generation: input.generation,
      streamId: input.streamId,
      payload: input.chunk.subarray(offset, offset + bytes),
    });
    offset += bytes;
  }
}
