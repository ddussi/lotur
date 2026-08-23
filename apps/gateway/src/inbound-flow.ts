import { RetiredDataBudget } from "../../../packages/relay/src/index.ts";

export class GatewayInboundFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayInboundFlowError";
  }
}

type StreamCredit = {
  readonly initial: number;
  available: number;
  outstanding: number;
};

export class GatewayInboundFlow {
  readonly #initialConnectionBytes: number;
  #connectionAvailable: number;
  readonly #streams = new Map<number, StreamCredit>();
  readonly #retiredData: RetiredDataBudget;

  constructor(initialConnectionBytes: number, maximumFrames = 4_096) {
    assertPositiveInteger(initialConnectionBytes, "initialConnectionBytes");
    assertPositiveInteger(maximumFrames, "maximumFrames");
    this.#initialConnectionBytes = initialConnectionBytes;
    this.#connectionAvailable = initialConnectionBytes;
    this.#retiredData = new RetiredDataBudget(initialConnectionBytes, maximumFrames);
  }

  openStream(streamId: number, initialStreamBytes: number): void {
    assertPositiveInteger(streamId, "streamId");
    assertPositiveInteger(initialStreamBytes, "initialStreamBytes");
    if (this.#streams.has(streamId)) {
      throw new GatewayInboundFlowError("stream credit already exists");
    }
    this.#streams.set(streamId, {
      initial: initialStreamBytes,
      available: initialStreamBytes,
      outstanding: 0,
    });
  }

  consume(streamId: number, bytes: number): void {
    assertPositiveInteger(bytes, "bytes");
    const stream = this.#requireStream(streamId);
    if (bytes > stream.available) {
      throw new GatewayInboundFlowError("DATA exceeds stream receive credit");
    }
    if (bytes > this.#connectionAvailable) {
      throw new GatewayInboundFlowError("DATA exceeds connection receive credit");
    }
    stream.available -= bytes;
    stream.outstanding += bytes;
    this.#connectionAvailable -= bytes;
  }

  release(streamId: number, bytes: number): void {
    assertPositiveInteger(bytes, "bytes");
    const stream = this.#requireStream(streamId);
    if (bytes > stream.outstanding) {
      throw new GatewayInboundFlowError("release exceeds consumed stream bytes");
    }
    stream.outstanding -= bytes;
    stream.available += bytes;
    this.#connectionAvailable += bytes;
    if (
      stream.available > stream.initial ||
      this.#connectionAvailable > this.#initialConnectionBytes
    ) {
      throw new GatewayInboundFlowError("receive credit exceeds configured maximum");
    }
  }

  closeStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#streams.delete(streamId);
    this.#connectionAvailable += stream.outstanding;
    if (this.#connectionAvailable > this.#initialConnectionBytes) {
      throw new GatewayInboundFlowError("connection receive credit exceeds configured maximum");
    }
  }

  retireStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#retiredData.allow(
      streamId,
      Math.min(stream.available, this.#connectionAvailable),
    );
    this.closeStream(streamId);
  }

  consumeRetiredData(streamId: number, bytes: number): void {
    this.#retiredData.consume(streamId, bytes);
  }

  #requireStream(streamId: number): StreamCredit {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) throw new GatewayInboundFlowError("stream credit does not exist");
    return stream;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
