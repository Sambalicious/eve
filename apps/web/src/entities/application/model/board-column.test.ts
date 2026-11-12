import { describe, expect, it } from "vitest"

import type { Application, BoardInfo } from "./application"
import { boardColumn, visibleColumns } from "./board-column"
import { boardColumnCopy } from "./board-copy"

const card = (board: Partial<BoardInfo> = {}, rest: Partial<Pick<Application, "state" | "failure">> = {}) => ({
  state: "prepared" as const,
  failure: null,
  ...rest,
  board: { submissionState: null, submissionKind: null, sampleState: null, latestOutcome: null, requestForAction: false, ...board },
})
const outcome = (type: NonNullable<BoardInfo["latestOutcome"]>["type"]) => ({ id: "o1", type, createdAt: "2026-11-01T00:00:00.000Z" })
const word = (a: ReturnType<typeof card>, advanced: boolean) => boardColumnCopy[boardColumn(a, { advanced }).column]

describe("boardColumn (ST application words, AC-4.2, AC-4.3)", () => {
  it.each([
    ["prepared, no submission", card(), false, "Draft"],
    ["generating", card({}, { state: "generating" }), false, "Draft"],
    ["document blocked", card({}, { state: "documents_blocked" }), false, "Draft"],
    ["document failed", card({}, { state: "documents_failed", failure: "provider_error" }), false, "Draft"],
    ["submissionState manual", card({ submissionState: "manual" }), false, "Applied"],
    ["submissionState confirmed", card({ submissionState: "confirmed" }), false, "Applied"],
    ["Outcome confirmation", card({ latestOutcome: outcome("confirmation") }), false, "Applied"],
    ["Outcome interview_invitation", card({ latestOutcome: outcome("interview_invitation") }), false, "Interview"],
    ["Outcome offer", card({ latestOutcome: outcome("offer") }), false, "Offer"],
    ["Outcome rejection", card({ latestOutcome: outcome("rejection") }), false, "Closed"],
    ["submissionState declined", card({ submissionState: "declined" }), false, "Closed"],
    ["submissionState not_submitted", card({ submissionState: "not_submitted" }), false, "Closed"],
    ["queued, Advanced on", card({ submissionState: "queued" }), true, "Sending"],
    ["submit_claimed, Advanced on", card({ submissionState: "submit_claimed" }), true, "Sending"],
    ["submitting, Advanced on", card({ submissionState: "submitting" }), true, "Sending"],
    ["blocked", card({ submissionState: "blocked" }), true, "Needs you"],
    ["uncertain", card({ submissionState: "uncertain" }), true, "Needs you"],
    ["sample awaiting review", card({ sampleState: "awaiting_review" }), true, "Needs you"],
    ["request_for_action after confirmation", card({ latestOutcome: outcome("confirmation"), requestForAction: true }), false, "Applied"],
  ])("%s -> %s (Advanced %s)", (_name, app, advanced, expected) => {
    expect(word(app, advanced)).toBe(expected)
  })

  it("AC-4.3: with Advanced off, queued sits in Draft and never reads Sending", () => {
    const placement = boardColumn(card({ submissionState: "queued" }), { advanced: false })
    expect(placement.column).toBe("draft")
    expect(placement.reason).toMatch(/waiting to send/i)
  })

  it.each(["blocked", "uncertain"] as const)("AC-3.7 safety rule: %s is Needs you even with Advanced off", (submissionState) => {
    expect(word(card({ submissionState }), false)).toBe("Needs you")
  })

  it("the safety override beats an Outcome", () => {
    expect(word(card({ submissionState: "blocked", latestOutcome: outcome("confirmation") }), true)).toBe("Needs you")
  })

  it("the newest Outcome decides: interview then rejection reads Closed", () => {
    expect(word(card({ latestOutcome: outcome("rejection") }), true)).toBe("Closed")
  })

  it("sub-states appear only in the reason line", () => {
    expect(boardColumn(card({}, { state: "generating" }), { advanced: false }).reason).toBe("Writing documents…")
    expect(boardColumn(card({}, { state: "documents_failed", failure: "provider_error" }), { advanced: false }).reason).toMatch(/^Couldn't make documents: /)
  })

  it("employer asked stays in its column and adds the line flag", () => {
    const placement = boardColumn(card({ latestOutcome: outcome("interview_invitation"), requestForAction: true }), { advanced: false })
    expect(placement.column).toBe("interview")
    expect(placement.employerAsked).toBe(true)
  })

  it("a row without board fields reads as Draft", () => {
    expect(boardColumn({ state: "documents_ready", failure: null }, { advanced: true }).column).toBe("draft")
  })

  it("at most five words with Advanced off and seven with Advanced on", () => {
    const all = [card(), card({ submissionState: "manual" }), card({ latestOutcome: outcome("interview_invitation") }), card({ latestOutcome: outcome("offer") }), card({ latestOutcome: outcome("rejection") }), card({ submissionState: "queued" }), card({ submissionState: "blocked" })]
    const on = new Set(all.map((a) => word(a, true)))
    expect(on.size).toBe(7)
    const nonSafety = all.filter((a) => a.board.submissionState !== "blocked")
    expect(new Set(nonSafety.map((a) => word(a, false))).size).toBeLessThanOrEqual(5)
  })
})

describe("visibleColumns", () => {
  it("shows the five columns, adding Sending only with Advanced on and Needs you whenever it holds a card", () => {
    const placements = [card({ submissionState: "queued" }), card({ submissionState: "blocked" })].map((a) => boardColumn(a, { advanced: true }))
    expect(visibleColumns(placements, true)).toEqual(["needsYou", "sending", "draft", "applied", "interview", "offer", "closed"])
    const off = [card({ submissionState: "queued" }), card({ submissionState: "blocked" })].map((a) => boardColumn(a, { advanced: false }))
    expect(visibleColumns(off, false)).toEqual(["needsYou", "draft", "applied", "interview", "offer", "closed"])
    expect(visibleColumns([], false)).toEqual(["draft", "applied", "interview", "offer", "closed"])
  })
})
