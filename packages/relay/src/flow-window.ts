export class FlowWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowWindowError";
  }
}

type StreamCredit = {
  available: number;
  outstanding: number;
};

type CreditWaiter = Readonly<{
  streamId: number;
  maximumBytes: number;
  resolve(bytes: number): void;
  reject(error: Error): void;
}>;

export class OutboundFlowWindow {
  readonly #initialConnectionBytes: number;
  #connectionAvailable: number;
  readonly #streams = new Map<number, StreamCredit>();
  readonly #waiters: CreditWaiter[] = [];
  #closed = false;

  constructor(initialConnectionBytes: number) {
    assertPositiveInteger(initialConnectionBytes, "initialConnectionBytes");
    this.#initialConnectionBytes = initialConnectionBytes;
    this.#connectionAvailable = initialConnectionBytes;
  }

  openStream(streamId: number, initialStreamBytes: number): void {
    assertPositiveInteger(streamId, "streamId");
    assertPositiveInteger(initialStreamBytes, "initialStreamBytes");
    if (this.#closed) throw new FlowWindowError("connection window is closed");
    if (this.#streams.has(streamId)) throw new FlowWindowError("stream window already exists");
    this.#streams.set(streamId, { available: initialStreamBytes, outstanding: 0 });
    this.#drainWaiters();
  }

  async take(streamId: number, maximumBytes: number): Promise<number> {
    assertPositiveInteger(maximumBytes, "maximumBytes");
    if (this.#closed) throw new FlowWindowError("connection window is closed");
    if (!this.#streams.has(streamId)) throw new FlowWindowError("stream window does not exist");
    return new Promise<number>((resolve, reject) => {
      this.#waiters.push({ streamId, maximumBytes, resolve, reject });
      this.#drainWaiters();
    });
  }

  update(streamId: number, bytes: number): void {
    assertPositiveInteger(bytes, "bytes");
    const stream = this.#streams.get(streamId);
    if (stream === undefined) throw new FlowWindowError("stream window does not exist");
    if (bytes > stream.outstanding) {
      throw new FlowWindowError("WINDOW_UPDATE exceeds outstanding bytes");
    }
    stream.outstanding -= bytes;
    stream.available += bytes;
    this.#connectionAvailable += bytes;
    if (this.#connectionAvailable > this.#initialConnectionBytes) {
      throw new FlowWindowError("connection window exceeds configured maximum");
    }
    this.#drainWaiters();
  }

  closeStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#streams.delete(streamId);
    this.#connectionAvailable += stream.outstanding;
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter?.streamId !== streamId) continue;
      this.#waiters.splice(index, 1);
      waiter.reject(new FlowWindowError("stream window does not exist"));
    }
    this.#drainWaiters();
  }

  close(): void {
    this.#closed = true;
    this.#streams.clear();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new FlowWindowError("connection window is closed"));
    }
  }

  #drainWaiters(): void {
    for (let index = 0; index < this.#waiters.length;) {
      const waiter = this.#waiters[index];
      if (waiter === undefined) break;
      const stream = this.#streams.get(waiter.streamId);
      if (stream === undefined) {
        this.#waiters.splice(index, 1);
        waiter.reject(new FlowWindowError("stream window does not exist"));
        continue;
      }
      const granted = Math.min(
        waiter.maximumBytes,
        stream.available,
        this.#connectionAvailable,
      );
      if (granted === 0) {
        index += 1;
        continue;
      }
      stream.available -= granted;
      stream.outstanding += granted;
      this.#connectionAvailable -= granted;
      this.#waiters.splice(index, 1);
      waiter.resolve(granted);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
