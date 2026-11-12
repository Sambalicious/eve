import { describe, expect, it } from "vitest"

import { formatWatDate, formatWatDateTime, watToday } from "./format-wat"

describe("WAT date formatting", () => {
  it("formats a timestamp in WAT, not browser time", () => {
    // 23:30 UTC is 00:30 the next day in WAT (UTC+1)
    expect(formatWatDate("2026-10-19T23:30:00Z")).toBe("20 Oct 2026")
    expect(formatWatDateTime("2026-10-20T09:15:00Z")).toBe("20 Oct 2026, 10:15 WAT")
  })

  it("writes every month with three letters, September included", () => {
    expect(formatWatDate("2026-09-24")).toBe("24 Sep 2026")
    expect(formatWatDateTime("2026-09-24T09:15:00Z")).toBe("24 Sep 2026, 10:15 WAT")
  })

  it("keeps a calendar date on its day", () => {
    expect(formatWatDate("2026-10-16")).toBe("16 Oct 2026")
  })
})

describe("watToday", () => {
  it("is the WAT calendar date, not the UTC one", () => {
    // 23:30 UTC on 19 Oct is 00:30 on 20 Oct in WAT
    expect(watToday(new Date("2026-10-19T23:30:00Z"))).toBe("2026-10-20")
    expect(watToday(new Date("2026-10-19T22:59:59Z"))).toBe("2026-10-19")
  })
})
