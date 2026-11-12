import type { SharedRuntimeConfig } from "../config/env.js"
import { DEFAULT_SPEND_CONFIG, type SpendConfig } from "./spend-math.js"

export const SPEND_CONFIG = Symbol("SPEND_CONFIG")

/** The spend settings from the process config; the defaults when none were parsed (tests, older callers). */
export function spendConfigOf(config: SharedRuntimeConfig): SpendConfig {
  return config.spend ?? DEFAULT_SPEND_CONFIG
}
