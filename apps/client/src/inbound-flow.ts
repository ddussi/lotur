import { RetiredDataBudget } from "../../../packages/relay/src/index.ts";

export class InboundFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundFlowError";
  }
}

type InboundStreamWindow = {
  readonly limit: number;
  consumedBytes: number;
  pendingFrames: number;
};

export class InboundFlowWindow {
  readonly #connectionLimit: number;
  readonly #maxPendingFrames: number;
  readonly #streams = new Map<number, InboundStreamWindow>();
  readonly #retiredData: RetiredDataBudget;
  #connectionConsumedBytes = 0;
  #pendingFrames = 0;

  constructor(connectionLimit: number, maxPendingFrames = 4_096) {
    assertPositiveInteger(connectionLimit, "connectionLimit");
    assertPositiveInteger(maxPendingFrames, "maxPendingFrames");
    this.#connectionLimit = connectionLimit;
    this.#maxPendingFrames = maxPendingFrames;
    this.#retiredData = new RetiredDataBudget(connectionLimit, maxPendingFrames);
  }

  openStream(streamId: number, streamLimit: number): void {
    assertStreamId(streamId);
    assertPositiveInteger(streamLimit, "streamLimit");
    if (this.#streams.has(streamId)) {
      throw new InboundFlowError(`stream ${streamId} already has an inbound window`);
    }
    this.#streams.set(streamId, {
      limit: streamLimit,
      consumedBytes: 0,
      pendingFrames: 0,
    });
  }

  consume(streamId: number, bytes: number): void {
    assertPositiveInteger(bytes, "DATA bytes");
    const stream = this.#requireStream(streamId);
    if (stream.consumedBytes + bytes > stream.limit) {
      throw new InboundFlowError(`stream ${streamId} exceeded inbound flow credit`);
    }
    if (this.#connectionConsumedBytes + bytes > this.#connectionLimit) {
      throw new InboundFlowError("connection exceeded inbound flow credit");
    }
    if (this.#pendingFrames >= this.#maxPendingFrames) {
      throw new InboundFlowError("too many pending inbound DATA frames");
    }
    stream.consumedBytes += bytes;
    stream.pendingFrames += 1;
    this.#connectionConsumedBytes += bytes;
    this.#pendingFrames += 1;
  }

  release(streamId: number, bytes: number): void {
    assertPositiveInteger(bytes, "released DATA bytes");
    const stream = this.#requireStream(streamId);
    if (stream.consumedBytes < bytes || stream.pendingFrames === 0) {
      throw new InboundFlowError(`stream ${streamId} released unconsumed credit`);
    }
    stream.consumedBytes -= bytes;
    stream.pendingFrames -= 1;
    this.#connectionConsumedBytes -= bytes;
    this.#pendingFrames -= 1;
  }

  closeStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#connectionConsumedBytes -= stream.consumedBytes;
    this.#pendingFrames -= stream.pendingFrames;
    this.#streams.delete(streamId);
  }

  retireStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#retiredData.allow(streamId, Math.min(
      stream.limit - stream.consumedBytes,
      this.#connectionLimit - this.#connectionConsumedBytes,
    ));
    this.closeStream(streamId);
  }

  consumeRetiredData(streamId: number, bytes: number): void {
    this.#retiredData.consume(streamId, bytes);
  }

  #requireStream(streamId: number): InboundStreamWindow {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      throw new InboundFlowError(`stream ${streamId} has no inbound window`);
    }
    return stream;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId <= 0 || streamId > 0xffff_ffff) {
    throw new RangeError("streamId must be a positive uint32");
  }
}
