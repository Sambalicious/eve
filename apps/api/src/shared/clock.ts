import { Global, Module } from "@nestjs/common"

/** Source of the current time. Tests replace it to cross the session expiry boundary. */
export interface Clock {
  now(): Date
}

export const CLOCK = Symbol("CLOCK")

export const systemClock: Clock = { now: () => new Date() }

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
