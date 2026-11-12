import { RETENTION_PATH } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { server } from "@/shared/testing"
import { fetchRetention, parseRetentionFilter } from "./retention-repository"

describe("fetchRetention (GET /v1/retention, v1.17.0)", () => {
  it("parses the contract body and maps it to the facts the section shows", async () => {
    server.use(
      http.get(RETENTION_PATH, () =>
        HttpResponse.json({
          rule: { months: 12 },
          dueNext30Days: { count: 2, earliestOn: "2026-10-28" },
          overdueDue: { count: 0 },
          waitingForDecision: { count: 1 },
          graceEndsOn: null,
          lastRun: { watDate: "2026-10-22", outcome: "failed", deletedCount: 0 },
          lastFailure: { watDate: "2026-10-22" },
        })
      )
    )
    expect(await fetchRetention()).toEqual({
      dueNext30Days: { count: 2, earliestOn: "2026-10-28" },
      waitingForDecisionCount: 1,
      graceEndsOn: null,
      lastFailureOn: "2026-10-22",
    })
  })

  it("rejects a body that breaks the contract", async () => {
    server.use(http.get(RETENTION_PATH, () => HttpResponse.json({ rule: { months: 6 } })))
    await expect(fetchRetention()).rejects.toThrow()
  })
})

describe("parseRetentionFilter (E5.7: page and API agree)", () => {
  it.each([
    ["retention=due", "due"],
    ["retention=waiting", "waiting"],
    ["retention=overdue", null],
    ["retention=DUE", null],
    ["retention=", null],
    ["retention=due,waiting", null],
    ["retention=due&retention=waiting", null],
    ["retention=due&retention=due", null],
    ["", null],
  ])("?%s is %s", (query, filter) => {
    expect(parseRetentionFilter(new URLSearchParams(query))).toBe(filter)
  })
})
