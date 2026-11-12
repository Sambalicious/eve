import { RESUME_MAX_BYTES } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { isAcceptableResume } from "./resume-file"

const fileOf = (name: string, bytes: number) => new File([new Uint8Array(bytes)], name)

describe("isAcceptableResume", () => {
  it.each([
    ["ada-okafor-resume.pdf", 1000, true],
    ["Ada Okafor CV.DOCX", 1000, true],
    ["ada-okafor-resume.png", 1000, false],
    ["ada-okafor-resume.doc", 1000, false],
    ["empty.pdf", 0, false],
    ["exactly-5mb.pdf", RESUME_MAX_BYTES, true],
    ["too-big.pdf", RESUME_MAX_BYTES + 1, false],
  ])("%s (%i bytes) → %s", (name, bytes, expected) => {
    expect(isAcceptableResume(fileOf(name, bytes))).toBe(expected)
  })
})
