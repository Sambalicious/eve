import { useId } from "react"
// No `useMutation`: its module lives in a chunk shared with dashboard routes,
// and the form keeps its in-flight state itself (F-QA-E3B-01, see ui/fields.tsx).
import { useQuery } from "@tanstack/react-query"

import { fetchProof, sendAccessRequest, type AccessRequestInput } from "../api/access-request-repository"
import { proofWaitMs } from "./form-state"

/** A proof older than this is fetched again before sending (the server accepts 24 h). */
const PROOF_REFRESH_MS = 23 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ProofUnavailableError extends Error {
  constructor() {
    super("The fill-time proof couldn't be fetched.")
    this.name = "ProofUnavailableError"
  }
}

/**
 * The dialog's server state (architecture r1 7.6, 8.3). Each open fetches a
 * new fill-time proof; nothing is fetched on page load. `send` waits for the
 * proof alignment rule, then posts; the form guards against double sends.
 */
export function useRequestAccess(openedAt: number) {
  const openId = useId()
  const proof = useQuery({
    queryKey: ["access-request", "proof", openId, openedAt],
    queryFn: fetchProof,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  /**
   * Sends the values. `refreshProof` is the Try again path: a failed or
   * missing proof is fetched again first. A plain Send with no proof fails as
   * a network error (Designer board item 4).
   */
  async function send(values: Omit<AccessRequestInput, "proof">, { refreshProof }: { refreshProof: boolean }) {
    let token = proof.data ?? null
    let proofAt = proof.dataUpdatedAt
    const stale = token !== null && Date.now() - proofAt > PROOF_REFRESH_MS
    if (token === null || stale) {
      if (!refreshProof && !stale) throw new ProofUnavailableError()
      const fresh = await proof.refetch()
      if (fresh.data === undefined) throw new ProofUnavailableError()
      token = fresh.data
      proofAt = fresh.dataUpdatedAt
    }
    const wait = proofWaitMs({ openedAt, proofAt, now: Date.now() })
    if (wait > 0) await sleep(wait)
    await sendAccessRequest({ ...values, proof: token })
  }

  return { send }
}
