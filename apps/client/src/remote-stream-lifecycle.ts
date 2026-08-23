export class RemoteStreamLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteStreamLifecycleError";
  }
}

export class RemoteStreamLifecycle {
  readonly #active = new Set<number>();
  #highestOpenedStreamId = 0;

  open(streamId: number): void {
    if (!Number.isInteger(streamId) || streamId <= 0 || streamId > 0xffff_ffff) {
      throw new RemoteStreamLifecycleError("remote stream ID must be a positive uint32");
    }
    if ((streamId & 1) === 0) {
      throw new RemoteStreamLifecycleError("gateway stream ID must be odd");
    }
    const expectedStreamId = this.#highestOpenedStreamId === 0
      ? 1
      : this.#highestOpenedStreamId + 2;
    if (streamId !== expectedStreamId) {
      if (streamId <= this.#highestOpenedStreamId) {
        throw new RemoteStreamLifecycleError(`remote stream ID ${streamId} was reused or reordered`);
      }
      throw new RemoteStreamLifecycleError(
        `remote stream ID ${streamId} is out of sequence; expected ${expectedStreamId}`,
      );
    }
    this.#highestOpenedStreamId = streamId;
    this.#active.add(streamId);
  }

  requireActive(streamId: number): void {
    if (!this.#active.has(streamId)) {
      const lifecycle = this.isRetired(streamId) ? "retired" : "unknown";
      throw new RemoteStreamLifecycleError(`${lifecycle} remote stream ID ${streamId}`);
    }
  }

  isRetired(streamId: number): boolean {
    return Number.isInteger(streamId) &&
      streamId > 0 &&
      streamId <= this.#highestOpenedStreamId &&
      (streamId & 1) === 1 &&
      !this.#active.has(streamId);
  }

  close(streamId: number): void {
    this.requireActive(streamId);
    this.#active.delete(streamId);
  }
}
