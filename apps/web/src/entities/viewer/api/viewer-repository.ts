import {
  ME_ADVANCED_PATH,
  ME_PATH,
  meNoteDismissPath,
  meResponseSchema,
  type MeNote,
  type MeResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { Viewer } from "../model/viewer"

function toViewer(body: MeResponse): Viewer {
  return {
    isOperator: body.isOperator,
    advancedEnabled: body.advancedEnabled,
    advancedLocked: body.advancedLocked,
    simplerNoteDue: body.simplerNoteDue,
    improveListDismissed: body.improveListDismissed,
  }
}

export async function fetchViewer(): Promise<Viewer> {
  const response = await apiRequest(ME_PATH)
  return toViewer(meResponseSchema.parse(await response.json()))
}

/** `PUT /v1/me/advanced`. Refuses with 409 `advanced_locked` while automatic applying is on. */
export async function setAdvanced(enabled: boolean, csrfToken: string): Promise<Viewer> {
  const response = await apiRequest(ME_ADVANCED_PATH, { method: "PUT", csrfToken, json: { enabled } })
  return toViewer(meResponseSchema.parse(await response.json()))
}

export async function dismissNote(note: MeNote, csrfToken: string): Promise<Viewer> {
  const response = await apiRequest(meNoteDismissPath(note), { method: "POST", csrfToken })
  return toViewer(meResponseSchema.parse(await response.json()))
}
