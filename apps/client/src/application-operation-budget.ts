export class ApplicationOperationBudget {
  readonly #limit: number;
  #pending = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("application operation limit must be a positive safe integer");
    }
    this.#limit = limit;
  }

  reserve(): () => void {
    if (this.#pending >= this.#limit) {
      throw new Error("connection application operation limit exceeded");
    }
    this.#pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pending -= 1;
    };
  }
}
