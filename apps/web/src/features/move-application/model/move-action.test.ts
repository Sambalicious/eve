import { describe, expect, it } from "vitest"

import { boardColumn, type Application, type BoardInfo } from "@/entities/application"
import { moveAction, moveOptions } from "./move-action"

type Card = Pick<Application, "state" | "failure" | "board" | "detailsDeletedAt">
const card = (board: Partial<BoardInfo> = {}, rest: Partial<Card> = {}): Card => ({
  state: "documents_ready",
  failure: null,
  detailsDeletedAt: null,
  board: { submissionState: null, submissionKind: null, sampleState: null, latestOutcome: null, requestForAction: false, ...board },
  ...rest,
})
const placed = (type: "confirmation" | "interview_invitation" | "offer" | "rejection") => ({ id: "o-1", type, createdAt: "2026-11-01T00:00:00.000Z" })
const options = (c: Card, advanced = false) => moveOptions(c, boardColumn(c, { advanced }), { advanced })
const labels = (c: Card, advanced = false) => options(c, advanced).map((o) => o.label)

describe("moveOptions and moveAction (BRD moves, AC-6.3 to AC-6.7)", () => {
  it("Draft offers only I applied, as a manual-complete", () => {
    expect(labels(card())).toEqual(["I applied"])
    expect(moveAction(card(), "applied", { advanced: false })).toEqual({ kind: "manualComplete" })
  })

  it.each([
    ["a minimal record", card({}, { detailsDeletedAt: "2026-11-01T00:00:00.000Z" })],
    ["a rejected sample", card({ sampleState: "rejected" })],
    ["a queued item with Advanced off", card({ submissionState: "queued" })],
  ])("Draft offers nothing for %s, because the server would refuse it", (_name, c) => {
    expect(labels(c)).toEqual([])
  })

  it("Applied (by submission state) records Outcomes forward and into Closed, and explains why not back to Draft", () => {
    const c = card({ submissionState: "manual" })
    expect(options(c).map((o) => [o.label, o.action.kind])).toEqual([
      ["Interview", "createOutcome"],
      ["Offer", "createOutcome"],
      ["Closed", "createOutcome"],
      ["Draft", "refused"],
    ])
    expect(moveAction(c, "interview", { advanced: false })).toEqual({ kind: "createOutcome", outcome: "interview_invitation" })
    expect(moveAction(c, "offer", { advanced: false })).toEqual({ kind: "createOutcome", outcome: "offer" })
    expect(moveAction(c, "draft", { advanced: false })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/Draft/) })
  })

  it("Interview offers Offer, Closed (a rejection) and Back to Applied, which edits the placing Outcome", () => {
    const c = card({ latestOutcome: placed("interview_invitation") })
    expect(labels(c)).toEqual(["Back to Applied", "Offer", "Closed"])
    expect(moveAction(c, "applied", { advanced: false })).toEqual({ kind: "editOutcome", outcomeId: "o-1", outcome: "confirmation" })
    expect(moveAction(c, "closed", { advanced: false })).toEqual({ kind: "createOutcome", outcome: "rejection" })
  })

  it("Offer offers Back to Interview, Back to Applied and Closed", () => {
    const c = card({ latestOutcome: placed("offer") })
    expect(labels(c)).toEqual(["Back to Applied", "Back to Interview", "Closed"])
    expect(moveAction(c, "interview", { advanced: false })).toEqual({ kind: "editOutcome", outcomeId: "o-1", outcome: "interview_invitation" })
  })

  it("Closed by an Outcome moves out by editing it; Closed by submission state can't be reopened", () => {
    expect(moveAction(card({ latestOutcome: placed("rejection") }), "applied", { advanced: false })).toEqual({
      kind: "editOutcome",
      outcomeId: "o-1",
      outcome: "confirmation",
    })
    const declined = card({ submissionState: "declined" })
    expect(options(declined).every((o) => o.action.kind === "refused")).toBe(true)
  })

  it("automatic cards have no menu, and with Advanced on the other cards list Sending and Needs you as disabled", () => {
    expect(options(card({ submissionState: "queued" }), true)).toEqual([])
    expect(options(card({ submissionState: "blocked" }), true)).toEqual([])
    const offer = options(card({ latestOutcome: placed("offer") }), true)
    expect(offer.slice(-2).map((o) => [o.label, o.action.kind])).toEqual([
      ["Sending", "refused"],
      ["Needs you", "refused"],
    ])
    expect(labels(card({ latestOutcome: placed("offer") }), false)).not.toContain("Sending")
  })

  it("never plans a write that deletes: no action kind other than create, edit and manual-complete exists", () => {
    const kinds = new Set(
      [card(), card({ submissionState: "manual" }), card({ latestOutcome: placed("interview_invitation") }), card({ latestOutcome: placed("offer") })].flatMap((c) =>
        options(c, true).map((o) => o.action.kind)
      )
    )
    expect([...kinds].sort()).toEqual(["createOutcome", "editOutcome", "manualComplete", "refused"])
  })
})
