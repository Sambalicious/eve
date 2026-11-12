import { LOGOUT_PATH } from "@eve/contracts"

import { apiRequest } from "@/shared/api"

/** Ends the session on the server. Succeeds with 204 and no body. */
export async function logout(csrfToken: string): Promise<void> {
  await apiRequest(LOGOUT_PATH, { method: "POST", csrfToken })
}
