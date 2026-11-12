import { describe, expect, it } from "vitest"

import { parseVmHwmKb, readPeakRssKb } from "./peak-rss.js"

describe("parseVmHwmKb", () => {
  it("reads the VmHWM line of a /proc status text, not VmRSS", () => {
    const status = "Name:\tnode\nVmPeak:\t  900000 kB\nVmHWM:\t   81234 kB\nVmRSS:\t   70000 kB\nThreads:\t11\n"
    expect(parseVmHwmKb(status)).toBe(81234)
  })

  it("is undefined when the line is missing or malformed", () => {
    expect(parseVmHwmKb("Name:\tnode\nVmRSS:\t 100 kB\n")).toBeUndefined()
    expect(parseVmHwmKb("VmHWM:\tlots kB\n")).toBeUndefined()
    expect(parseVmHwmKb("")).toBeUndefined()
  })
})

describe("readPeakRssKb", () => {
  it("returns a positive number of kilobytes for this process", () => {
    expect(readPeakRssKb()).toBeGreaterThan(1000)
  })
})
