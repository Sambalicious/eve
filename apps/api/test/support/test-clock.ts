import type { Clock } from "../../src/shared/clock.js"

/** A clock tests move by hand to cross the session expiry boundary. */
export class TestClock implements Clock {
  private current: Date

  constructor(start: Date | string) {
    this.current = new Date(start)
  }

  now(): Date {
    return new Date(this.current)
  }

  set(time: Date | string): void {
    this.current = new Date(time)
  }
}
