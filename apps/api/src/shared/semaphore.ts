/**
 * A counting semaphore for one process: at most `slots` holders run `use` at
 * once; the rest wait in arrival order. A waiter holds nothing while it waits.
 */
export class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw new RangeError("Semaphore needs at least one slot")
  }

  async use<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await work()
    } finally {
      this.release()
    }
  }

  /** Holders running now (for tests and logs). */
  get inUse(): number {
    return this.active
  }

  private acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    // The slot passes straight to the next waiter, so `active` stays the same.
    if (next) next()
    else this.active--
  }
}
