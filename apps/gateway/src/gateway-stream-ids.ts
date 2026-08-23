export class GatewayStreamIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayStreamIdError";
  }
}

export class GatewayStreamIds {
  #highestIssuedStreamId = 0;

  issue(): number {
    if (this.#highestIssuedStreamId > 0xffff_fffd) {
      throw new GatewayStreamIdError("gateway stream ID space is exhausted");
    }
    this.#highestIssuedStreamId = this.#highestIssuedStreamId === 0
      ? 1
      : this.#highestIssuedStreamId + 2;
    return this.#highestIssuedStreamId;
  }

  wasIssued(streamId: number): boolean {
    return Number.isInteger(streamId) &&
      streamId > 0 &&
      streamId <= this.#highestIssuedStreamId &&
      (streamId & 1) === 1;
  }

  reset(): void {
    this.#highestIssuedStreamId = 0;
  }
}
