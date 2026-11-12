import {
  CONTROLS_PATH,
  controlsSchema,
  GLOBAL_PAUSE_PATH,
  MONTHLY_CEILING_PATH,
  raiseCeilingResponseSchema,
  type Controls,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { AutomationState, RaiseCeilingResult } from "../model/automation-state"

export async function fetchAutomationState(): Promise<AutomationState> {
  const response = await apiRequest(CONTROLS_PATH)
  return toAutomationState(controlsSchema.parse(await response.json()))
}

/** Pausing and resuming only touch the global pause; the cost pause is the backend's. */
export async function setGlobalPause(paused: boolean, csrfToken: string): Promise<AutomationState> {
  const response = await apiRequest(GLOBAL_PAUSE_PATH, { method: "PUT", csrfToken, json: { paused } })
  return toAutomationState(controlsSchema.parse(await response.json()))
}

/** `month` is the current WAT month; `ceiling` is the text as typed. A rule refusal is a 200 with the C-VAL-COST text. */
export async function raiseCeiling(month: string, ceiling: string, csrfToken: string): Promise<RaiseCeilingResult> {
  const response = await apiRequest(MONTHLY_CEILING_PATH, { method: "PUT", csrfToken, json: { month, ceiling } })
  const body = raiseCeilingResponseSchema.parse(await response.json())
  return body.result === "raised"
    ? { kind: "raised", state: toAutomationState(body.controls), costPauseCleared: body.costPauseCleared }
    : { kind: "refused", message: body.message }
}

function toAutomationState(body: Controls): AutomationState {
  const { spend } = body
  return {
    globalPaused: body.globalPaused,
    costPause: body.costPause && { pausedAt: body.costPause.pausedAt, resumesAt: body.costPause.resumesAt },
    spend: {
      month: spend.month,
      spent: spend.spent,
      ceiling: spend.ceiling,
      defaultCeiling: spend.defaultCeiling,
      raised: spend.raised,
      maxCeiling: spend.maxCeiling,
      canRaise: spend.canRaise,
      percentUsed: spend.percentUsed,
      byCategory: { ...spend.byCategory },
    },
  }
}
