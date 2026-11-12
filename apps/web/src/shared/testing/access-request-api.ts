import {
  ACCESS_REQUEST_PATH,
  ACCESS_REQUEST_PROOF_PATH,
  accessRequestAcceptedSchema,
  accessRequestBodySchema,
  accessRequestProofSchema,
  apiErrorResponseSchema,
  type AccessRequestBody,
  type AccessRequestFieldCode,
} from "@eve/contracts"
import { delay, http, HttpResponse } from "msw"

/** A proof shaped like the contract's `<issuedAtMs>.<sig>`. */
export const TEST_PROOF = "1792580000000.dGVzdC1wcm9vZi1zaWc"

export type AccessRequestApi = ReturnType<typeof createAccessRequestApi>

type Reply = "accept" | "network" | "timeout" | "server_error" | "rate_ip" | "rate_global" | "forbidden" | { fields: AccessRequestFieldCode[] }

/**
 * Contract-derived handlers for v1.16.0 request access (architecture r1 7.3).
 * Every body and response is parsed through the contract schemas, so a fixture
 * can't drift from it. `replies` are used in order; the last one repeats.
 */
export function createAccessRequestApi({ replies = ["accept"], delayMs = 0, proof = "ok" }: { replies?: Reply[]; delayMs?: number; proof?: "ok" | "fail" | "fail-once" } = {}) {
  const state = { bodies: [] as AccessRequestBody[], proofCalls: 0 }
  let next = 0
  const handlers = [
    http.get(ACCESS_REQUEST_PROOF_PATH, () => {
      state.proofCalls += 1
      if (proof === "fail" || (proof === "fail-once" && state.proofCalls === 1)) return HttpResponse.error()
      return HttpResponse.json(accessRequestProofSchema.parse({ proof: TEST_PROOF }), { headers: { "cache-control": "no-store" } })
    }),
    http.post(ACCESS_REQUEST_PATH, async ({ request }) => {
      state.bodies.push(accessRequestBodySchema.parse(await request.json()))
      const reply = replies[Math.min(next++, replies.length - 1)]
      if (delayMs) await delay(delayMs)
      if (reply === "network") return HttpResponse.error()
      if (reply === "timeout") {
        await delay("infinite")
        return HttpResponse.error()
      }
      if (reply === "accept") return HttpResponse.json(accessRequestAcceptedSchema.parse({ status: "received" }), { status: 202, headers: { "cache-control": "no-store" } })
      const error = (code: string, message: string, status: number, extra: object = {}) =>
        HttpResponse.json(apiErrorResponseSchema.parse({ error: { code, message, ...extra } }), { status, headers: { "cache-control": "no-store" } })
      if (reply === "server_error") return error("internal_error", "Something went wrong.", 500)
      if (reply === "rate_ip") return error("rate_limited_ip", "Too many requests from this network. Try again later.", 429)
      if (reply === "rate_global") return error("rate_limited_global", "Eve can't take more requests today. Try again tomorrow.", 429)
      if (reply === "forbidden") return error("origin_forbidden", "This request must come from the Eve page.", 403)
      return error("access_request_invalid", "Check the highlighted fields.", 400, { fields: reply.fields })
    }),
  ]
  return {
    handlers,
    get bodies() {
      return state.bodies
    },
    get proofCalls() {
      return state.proofCalls
    },
  }
}
