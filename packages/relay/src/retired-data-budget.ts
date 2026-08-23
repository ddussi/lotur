export class RetiredDataBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetiredDataBudgetError";
  }
}

export class RetiredDataBudget {
  readonly #maximumBytes: number;
  readonly #maximumTrackedStreams: number;
  #remainingBytes: number;
  readonly #streamBytes = new Map<number, number>();
  #remainingFrames: number;

  constructor(maximumBytes: number, maximumFrames: number) {
    assertPositiveInteger(maximumBytes, "maximumBytes");
    assertPositiveInteger(maximumFrames, "maximumFrames");
    this.#maximumBytes = maximumBytes;
    this.#maximumTrackedStreams = maximumFrames;
    this.#remainingBytes = maximumBytes;
    this.#remainingFrames = maximumFrames;
  }

  allow(streamId: number, bytes: number): void {
    assertPositiveInteger(streamId, "streamId");
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("retired DATA allowance must be a non-negative safe integer");
    }
    if (
      bytes === 0 ||
      this.#remainingFrames === 0 ||
      this.#remainingBytes === 0 ||
      this.#streamBytes.has(streamId)
    ) return;
    if (this.#streamBytes.size >= this.#maximumTrackedStreams) {
      const oldestStreamId = this.#streamBytes.keys().next().value;
      if (oldestStreamId !== undefined) this.#streamBytes.delete(oldestStreamId);
    }
    this.#streamBytes.set(streamId, Math.min(bytes, this.#maximumBytes));
  }

  consume(streamId: number, bytes: number): void {
    assertPositiveInteger(streamId, "streamId");
    assertPositiveInteger(bytes, "retired DATA bytes");
    if (this.#remainingFrames === 0) {
      throw new RetiredDataBudgetError("retired DATA frame budget is exhausted");
    }
    const availableBytes = this.#streamBytes.get(streamId) ?? 0;
    if (bytes > availableBytes || bytes > this.#remainingBytes) {
      throw new RetiredDataBudgetError("retired DATA byte budget is exhausted");
    }
    this.#remainingFrames -= 1;
    this.#remainingBytes -= bytes;
    const remainingBytes = availableBytes - bytes;
    this.#streamBytes.delete(streamId);
    if (this.#remainingFrames === 0 || this.#remainingBytes === 0) {
      this.#streamBytes.clear();
    } else if (remainingBytes > 0) {
      // A stream that has already produced a valid late frame is more likely to
      // have another in-flight continuation than an unused older allowance.
      this.#streamBytes.set(streamId, remainingBytes);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
