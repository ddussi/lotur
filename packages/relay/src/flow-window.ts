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

export class OutboundFlowWindow {
  readonly #initialConnectionBytes: number;
  #connectionAvailable: number;
  readonly #streams = new Map<number, StreamCredit>();
  readonly #waiters = new Set<() => void>();
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
    this.#notify();
  }

  async take(streamId: number, maximumBytes: number): Promise<number> {
    assertPositiveInteger(maximumBytes, "maximumBytes");
    while (true) {
      if (this.#closed) throw new FlowWindowError("connection window is closed");
      const stream = this.#streams.get(streamId);
      if (stream === undefined) throw new FlowWindowError("stream window does not exist");
      const granted = Math.min(maximumBytes, stream.available, this.#connectionAvailable);
      if (granted > 0) {
        stream.available -= granted;
        stream.outstanding += granted;
        this.#connectionAvailable -= granted;
        return granted;
      }
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
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
    this.#notify();
  }

  closeStream(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#streams.delete(streamId);
    this.#connectionAvailable += stream.outstanding;
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#streams.clear();
    this.#notify();
  }

  #notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

