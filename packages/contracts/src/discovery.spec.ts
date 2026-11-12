import { describe, expect, it } from "vitest"

import {
  ruleNameSchema,
  JOB_POSTINGS_CURSOR_MAX_LENGTH,
  JOB_POSTINGS_DEFAULT_LIMIT,
  jobPostingsPath,
  jobPostingsQuerySchema,
  postingKeywordSchema,
  jobPostingsResponseSchema,
  roleFamilySchema,
} from "./index.js"

const parse = (query: Record<string, unknown>) => jobPostingsQuerySchema.safeParse(query)

describe("v1.12.0 GET /v1/job-postings query (slice 8, 8P.1, 8P.12, 8F.2, 8F.4)", () => {
  it("defaults: tab all, limit 25, no filter, no cursor", () => {
    expect(parse({})).toEqual({ success: true, data: { tab: "all", limit: JOB_POSTINGS_DEFAULT_LIMIT, families: [], keyword: null, cursor: null } })
    expect(JOB_POSTINGS_DEFAULT_LIMIT).toBe(25)
  })

  it.each(["1", "2", "25", "99", "100"])("accepts limit %s", (limit) => {
    expect(parse({ limit }).data?.limit).toBe(Number(limit))
  })

  it.each(["0", "101", "-1", "-25", "2.5", "25.0", "ten", "1e2", "1000", "", "025", "+5", " 5", "0x10"])("refuses limit %j", (limit) => {
    expect(parse({ limit }).success).toBe(false)
  })

  it("refuses a repeated parameter (an array) and unknown parameters", () => {
    expect(parse({ limit: ["1", "2"] }).success).toBe(false)
    expect(parse({ families: ["backend", "mobile"] }).success).toBe(false)
    for (const extra of ["page", "offset", "sort", "family", "q"]) expect(parse({ [extra]: "x" }).success).toBe(false)
  })

  it.each(["Ranked", "excluded", "ALL"])("refuses tab %s", (tab) => {
    expect(parse({ tab }).success).toBe(false)
  })

  it("families: comma list, deduplicated and sorted; empty means none", () => {
    expect(parse({ families: "mobile,backend,backend" }).data?.families).toEqual(["backend", "mobile"])
    expect(parse({ families: "" }).data?.families).toEqual([])
    expect(parse({ families: roleFamilySchema.options.join(",") }).data?.families).toHaveLength(13)
  })

  it.each(["robotics", "Backend", "BACKEND", "frontend", "devops", "backend,", ",backend", "backend,,mobile", "backend, mobile", "senior-frontend", "null"])(
    "refuses families %j",
    (families) => {
      expect(parse({ families }).success).toBe(false)
    }
  )

  it("keyword: trimmed; blank means none; at most 100 characters after trimming", () => {
    expect(parse({ keyword: "  react  " }).data?.keyword).toBe("react")
    expect(parse({ keyword: "   \t  " }).data?.keyword).toBeNull()
    expect(parse({ keyword: "" }).data?.keyword).toBeNull()
    expect(parse({ keyword: "a".repeat(100) }).data?.keyword).toBe("a".repeat(100))
    expect(parse({ keyword: `${" ".repeat(10)}${"a".repeat(100)}${" ".repeat(10)}` }).data?.keyword).toBe("a".repeat(100))
    expect(parse({ keyword: "a".repeat(101) }).success).toBe(false)
    expect(parse({ keyword: ` ${"a".repeat(101)} ` }).success).toBe(false)
    // Length is counted in UTF-16 code units, as the browser's maxlength counts it.
    expect(parse({ keyword: "😀".repeat(50) }).success).toBe(true)
    expect(parse({ keyword: "😀".repeat(51) }).success).toBe(false)
  })

  // v1.12.1 (F-QA8-01): control characters other than whitespace are refused; Postgres cannot store NUL.
  it.each(["\u0000", "re\u0000act", "react\u0000", "\u0001", "a\u0008b", "a\u000eb", "a\u001fb", "a\u007fb", "  \u0000  "])(
    "keyword %j with a non-whitespace control character is refused",
    (keyword) => {
      expect(parse({ keyword }).success).toBe(false)
      expect(postingKeywordSchema.safeParse(keyword).success).toBe(false)
    }
  )

  it("whitespace controls are allowed: trimmed at the ends, folded to one space inside", () => {
    expect(parse({ keyword: "\t react \n" }).data?.keyword).toBe("react")
    expect(parse({ keyword: "lead\tengineer" }).data?.keyword).toBe("lead\tengineer")
    expect(parse({ keyword: "\r\n\v\f" }).data?.keyword).toBeNull()
    expect(parse({ keyword: "Développeur 100%_\\" }).data?.keyword).toBe("Développeur 100%_\\")
    expect(postingKeywordSchema.parse("  react ")).toBe("react")
  })

  it("cursor: 1 to 1,024 characters; an empty cursor is refused", () => {
    expect(JOB_POSTINGS_CURSOR_MAX_LENGTH).toBe(1024)
    expect(parse({ cursor: "abc" }).data?.cursor).toBe("abc")
    expect(parse({ cursor: "" }).success).toBe(false)
    expect(parse({ cursor: "a".repeat(1024) }).success).toBe(true)
    expect(parse({ cursor: "a".repeat(1025) }).success).toBe(false)
  })
})

describe("v1.12.0 GET /v1/job-postings response and role families", () => {
  it("role families: v1.18.0 has the 13 keys in AC-1.2 display order (was nine in v1.12.0, 8R.1, 8R.7)", () => {
    expect(roleFamilySchema.options).toEqual([
      "senior_frontend",
      "technical_lead",
      "fullstack",
      "product_engineering",
      "software_engineering",
      "backend",
      "mobile",
      "platform_engineering",
      "devops_platform",
      "people_management",
      "data_ml",
      "solutions_customer",
      "other",
    ])
  })

  // v1.13.0 (merge with EPIC-0004): criteriaEmptyState is also required alongside slice 8's nextCursor and totalCount.
  it("requires nextCursor, totalCount and criteriaEmptyState", () => {
    // v1.18.0 adds four more required keys (role-relevance.spec.ts covers them).
    const valid = {
      postings: [],
      waitingToBeCheckedCount: 0,
      nextCursor: null,
      totalCount: 0,
      criteriaEmptyState: false,
      hiddenCounts: { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: 0 },
      recheckableCount: 0,
      targetRoleFamilies: ["senior_frontend"],
      waitingReason: null,
    }
    expect(jobPostingsResponseSchema.safeParse(valid).success).toBe(true)
    expect(jobPostingsResponseSchema.safeParse({ postings: [], waitingToBeCheckedCount: 0 }).success).toBe(false)
    expect(jobPostingsResponseSchema.safeParse({ postings: [], waitingToBeCheckedCount: 0, nextCursor: null, totalCount: 0 }).success).toBe(false)
    expect(jobPostingsResponseSchema.safeParse({ ...valid, nextCursor: "" }).success).toBe(false)
    expect(jobPostingsResponseSchema.safeParse({ ...valid, totalCount: -1 }).success).toBe(false)
  })

  it("builds the path in the order tab, families, keyword, limit, cursor, leaving out defaults", () => {
    expect(jobPostingsPath({ tab: "ranked" })).toBe("/v1/job-postings?tab=ranked")
    expect(jobPostingsPath({ tab: "all", families: ["mobile", "backend"], keyword: "100% react", limit: 1, cursor: "a.b" })).toBe(
      "/v1/job-postings?tab=all&families=mobile%2Cbackend&keyword=100%25+react&limit=1&cursor=a.b"
    )
    expect(jobPostingsPath({ tab: "skipped", families: [], keyword: "  " })).toBe("/v1/job-postings?tab=skipped")
  })
})

describe("ruleNameSchema (v1.25.0, D44)", () => {
  it("lists the seven Eligibility rules in stored order, seniority and employment_type after industry", () => {
    expect(ruleNameSchema.options).toEqual(["location", "sponsorship", "pay", "hours", "industry", "seniority", "employment_type"])
  })
})
