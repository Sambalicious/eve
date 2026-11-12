import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { settledSampleResult, submissionQueryOptions, submissionStatusQueryOptions, type SampleResult } from "@/entities/application"

/** First check 2 s after the approval, then 1.5 times longer each time, up to 10 s. */
export const SETTLE_FIRST_DELAY_MS = 2_000
export const SETTLE_MAX_DELAY_MS = 10_000
/** After this long the page stops asking and says so. */
export const SETTLE_GIVE_UP_MS = 5 * 60_000

export function settleDelay(attempt: number): number {
  return Math.min(SETTLE_MAX_DELAY_MS, Math.round(SETTLE_FIRST_DELAY_MS * 1.5 ** attempt))
}

/**
 * Follows an approved sample until the worker finishes it (api-contract
 * v1.8.0 `pending`): polls `GET /v1/applications/{id}/submission` with back-off
 * while the sample is approved with no state, claimed or submitting. Calls
 * `onSettled` with the result it now stands for, read with the new count from
 * `GET /v1/submission/status`. Stops on unmount, and gives up after
 * SETTLE_GIVE_UP_MS (`stalled`).
 */
export function useSampleSettle(applicationId: string, active: boolean, onSettled: (result: SampleResult) => void) {
  const queryClient = useQueryClient()
  const [stalled, setStalled] = useState(false)
  // The latest callback, so a new identity doesn't restart the polling.
  const settledRef = useRef(onSettled)
  useEffect(() => {
    settledRef.current = onSettled
  })

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const check = async (attempt: number) => {
      try {
        const submission = await queryClient.fetchQuery({ ...submissionQueryOptions(applicationId), staleTime: 0 })
        const settled = settledSampleResult(submission)
        if (cancelled) return
        if (settled) {
          const status = await queryClient.fetchQuery({ ...submissionStatusQueryOptions(), staleTime: 0 })
          if (cancelled) return
          settledRef.current({ result: settled, alreadyDone: false, countingSamples: status.countingSamples, gatePassedAt: status.gatePassedAt })
          return
        }
      } catch {
        // A failed read is retried on the next tick.
        if (cancelled) return
      }
      const delay = settleDelay(attempt + 1)
      if (Date.now() - startedAt + delay > SETTLE_GIVE_UP_MS) return setStalled(true)
      timer = setTimeout(() => void check(attempt + 1), delay)
    }
    timer = setTimeout(() => void check(0), settleDelay(0))
    return () => {
      cancelled = true
      clearTimeout(timer)
      setStalled(false)
    }
  }, [active, applicationId, queryClient])

  return { stalled: active && stalled }
}
