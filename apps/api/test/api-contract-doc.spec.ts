import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { HttpStatus } from "@nestjs/common"
import { apiErrorCodeSchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { API_ERROR_MESSAGES, ApiException } from "../src/http/api-exception.js"

const CONTRACT = fileURLToPath(
  new URL("../../../epics/active/EPIC-0001-job-application-assistant/api-contract.md", import.meta.url)
)
/** v1.18.0: EPIC-0006's handoff documents the codes it adds (`posting_hidden`) in the same table format. */
const EPIC_0006_CONTRACT = fileURLToPath(new URL("../../../epics/active/EPIC-0006-role-relevance-filter/api-contract.r1.md", import.meta.url))
/** v1.27.0: EPIC-0010's handoff documents its nine codes in the same table format. */
const EPIC_0010_CONTRACT = fileURLToPath(new URL("../../../epics/active/EPIC-0010-pasted-job-description/api-contract.md", import.meta.url))
/** v1.28.0: EPIC-0011's handoff documents `advanced_locked` (message not in backticks, so the row pattern allows both). */
const EPIC_0011_CONTRACT = fileURLToPath(new URL("../../../epics/active/EPIC-0011-simplify-eve/api-contract.md", import.meta.url))

/** Rows of the "Error format" tables: | `code` | HTTP | `message` | When | */
function documentedErrors(): Map<string, { status: number; message: string }> {
  const rows = new Map<string, { status: number; message: string }>()
  for (const line of [readFileSync(CONTRACT, "utf8"), readFileSync(EPIC_0006_CONTRACT, "utf8"), readFileSync(EPIC_0010_CONTRACT, "utf8"), readFileSync(EPIC_0011_CONTRACT, "utf8")].join("\n").split("\n")) {
    const match = /^\| `([a-z_]+)` \| (\d{3}) \| `?([^`|]*?)`? \|/.exec(line)
    if (match) rows.set(match[1]!, { status: Number(match[2]), message: match[3]! })
  }
  return rows
}

// The handoff document is what the Frontend Engineer reads; it must match the code.
describe("api-contract.md error table", () => {
  const documented = documentedErrors()

  it("documents every ApiErrorCode and nothing else", () => {
    expect([...documented.keys()].sort()).toEqual([...apiErrorCodeSchema.options].sort())
  })

  it.each(apiErrorCodeSchema.options)("%s has the documented status and exact message", (code) => {
    const exception = new ApiException(code)
    expect(documented.get(code)).toEqual({ status: exception.getStatus(), message: API_ERROR_MESSAGES[code] })
    expect(Object.values(HttpStatus)).toContain(exception.getStatus())
  })
})

// Run a2e (F-CR-03): EPIC-0006 took v1.18.0 on main. Run a2i (F-CR-06, D19): EPIC-0007 took v1.19.0 and
// v1.20.0, so EPIC-0002 A2's additions are v1.21.0. EPIC-0008 then took v1.22.0, apply anyway v1.23.0 and EPIC-0008
// hardening v1.23.1, so B1 was v1.24.0 (D19, renumbered at the merge with main 6933243). Apply anyway bounds then
// took v1.24.0, so B1 is v1.25.0 (renumbered at the merge with main 0422b14).
describe("api-contract.md EPIC-0002 A2 version", () => {
  const contract = readFileSync(CONTRACT, "utf8")

  it("labels A2's GET /v1/me and feature_not_yet_available v1.21.0, v1.18.0 EPIC-0006 and v1.19.0/v1.20.0 EPIC-0007", () => {
    // v1.25.1 (EPIC-0002 B1 patch CR-B1-02) took the header, on v1.25.0 (EPIC-0002 B1) and v1.24.0 (apply anyway, bounds and consent); the A2 label stays as its "Earlier header".
    expect(contract).toMatch(/^Owner: Backend Engineer\. Version `v1\.25\.1` \(EPIC-0002 B1 patch CR-B1-02.*on v1\.25\.0 EPIC-0002 B1 Job Preferences.*on v1\.24\.0 apply anyway, bounds and consent.*Earlier header: version `v1\.21\.0` \(EPIC-0002 A2/m)
    expect(contract).toMatch(/^### EPIC-0002 A2: who am I, and routes before conversion \(v1\.21\.0\)$/m)
    expect(contract).toMatch(/^\| `feature_not_yet_available` \| 409 \| [^|]+\| v1\.21\.0 \(EPIC-0002 A2\)/m)
    expect(contract).toMatch(/^\| v1\.18\.0 \| [0-9-]+ \| EPIC-0006 role relevance/m)
    expect(contract).toMatch(/^\| v1\.19\.0 \| [0-9-]+ \| EPIC-0007 Phase 1 /m)
    expect(contract).toMatch(/^\| v1\.20\.0 \| [0-9-]+ \| EPIC-0007 Phase 3 /m)
    expect(contract).toMatch(/^\| v1\.21\.0 \| [0-9-]+ \| EPIC-0002 A2 /m)
    expect(contract).not.toMatch(/^\| v1\.(18|19|20)\.0 \| [0-9-]+ \| EPIC-0002/m)
    expect(contract).not.toMatch(/v1\.(18|19|20)\.0 \(EPIC-0002 A2/)
  })

  it("labels B1's Job Preferences v1.25.0, after EPIC-0008's v1.22.0, apply anyway's v1.23.0, EPIC-0008 hardening's v1.23.1 and apply anyway bounds' v1.24.0", () => {
    expect(contract).toMatch(/^### EPIC-0002 B1: Job Preferences in the rules \(v1\.25\.0\)$/m)
    expect(contract).toMatch(/^\| v1\.22\.0 \| [0-9-]+ \| EPIC-0008 /m)
    expect(contract).toMatch(/^\| v1\.23\.0 \| [0-9-]+ \| Apply anyway /m)
    expect(contract).toMatch(/^\| v1\.23\.1 \| [0-9-]+ \| EPIC-0008 hardening /m)
    expect(contract).toMatch(/^\| v1\.24\.0 \| [0-9-]+ \| Apply anyway: bounds and consent /m)
    expect(contract).toMatch(/^\| v1\.25\.0 \| [0-9-]+ \| EPIC-0002 B1 /m)
    // v1.25.1 (CR-B1-02): the re-check runs with or without an override; the exempting sentence is gone.
    expect(contract).toMatch(/^\| v1\.25\.1 \| [0-9-]+ \| EPIC-0002 B1 patch \(code review CR-B1-02/m)
    expect(contract).toContain("A Candidate's own re-check runs whenever the check finds the Application submittable, whether or not an override is recorded (v1.25.1, CR-B1-02)")
    expect(contract).not.toContain("submittable and no override is recorded")
    expect(contract).toMatch(/^\| `preferences_stale` \| 409 \| [^|]+\| v1\.25\.0 \(EPIC-0002 B1\)/m)
    expect(contract).toMatch(/^\| `timezone_change_rate_limited` \| 409 \| [^|]+\| v1\.25\.0 \(EPIC-0002 B1, D41\)/m)
    expect(contract).not.toMatch(/^\| v1\.2[0-4]\.[0-9] \| [0-9-]+ \| EPIC-0002 B1/m)
    expect(contract).not.toMatch(/v1\.2[34]\.0 \(EPIC-0002 B1/)
    expect(contract).toMatch(/Migration `0027` \(developed as `0025`, renumbered `0026` after `0025-apply-anyway` and `0027` after `0026-apply-anyway-bounds`\) adds `candidate_posting\.preferences_version`/)
  })
})

// Slice 8d (PF-80, 8d.19, 8d.21, 8d.26): the contract states the 8d rules and no stale keyword sentence.
describe("api-contract.md slice 8d content", () => {
  const contract = readFileSync(CONTRACT, "utf8")
  const fold = readFileSync(fileURLToPath(new URL("../../../packages/contracts/src/keyword-fold.ts", import.meta.url)), "utf8")

  it("states the cursor bound, the invisible keyword rule, both statement timeouts and the fold backfill rule", () => {
    expect(contract).toMatch(/outside 1970-01-01T00:00:00Z to 2200-01-01T00:00:00Z \(both inclusive\) is `400`/)
    expect(contract).toMatch(/empty after `foldForKeywords`[^|]*is no keyword/)
    expect(contract).toMatch(/`keywordFoldsToEmpty`/)
    expect(contract).toMatch(/api's database pool sets `statement_timeout` to 5 s, the worker's to 60 s/)
    expect(contract).toMatch(/any change to `foldForKeywords` ships a migration that recomputes `title_folded` for every titled row/)
  })

  it("the fold's source comment states the backfill rule", () => {
    expect(fold).toMatch(/any change to this function ships a migration that\s+\*?\s*recomputes `job_posting\.title_folded` for every titled row/)
  })

  it("never says the web's postings URL parser checks only the keyword length", () => {
    expect(contract).not.toMatch(/postings-url\.ts[^.\n]*only[^.\n]*length/i)
    expect(contract).not.toMatch(/checks only the (keyword )?length/i)
  })
})

/** Every `@OperatorOnly()` route in apps/api/src as "METHOD /path", path params written `{name}`. */
function operatorOnlyRoutes(): string[] {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url))
  const routes: string[] = []
  for (const file of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".controller.ts")) continue
    let prefix = ""
    let operatorOnly = false
    for (const line of readFileSync(srcDir + file, "utf8").split("\n")) {
      const controller = /@Controller\("([^"]+)"\)/.exec(line)
      if (controller) prefix = controller[1]!
      if (/@OperatorOnly\(\)/.test(line)) operatorOnly = true
      const route = /@(Get|Post|Put|Patch|Delete)\((?:"([^"]*)")?\)/.exec(line)
      if (route && operatorOnly) {
        const path = ["", prefix, route[2]].filter((part) => part !== undefined && part !== "").join("/")
        routes.push(`${route[1]!.toUpperCase()} /${path.replace(/^\//, "")}`.replace(/:([A-Za-z]+)/g, "{$1}"))
        operatorOnly = false
      }
    }
  }
  return routes.sort()
}

// v1.25.0 (EPIC-0002 B1): PUT /v1/eligibility-settings is removed, so four Operator-only writes remain.
// The code assertion is red until the B1 implementation deletes the route.
describe("api-contract.md EPIC-0002 A2 Operator-only writes (D27, F-CR-10)", () => {
  const contract = readFileSync(CONTRACT, "utf8")
  const paragraph = /^\*\*Operator-only shared catalog writes \(A2\)\.\*\*.*$/m.exec(contract)?.[0] ?? ""

  it("the code has the four Operator-only shared writes left after B1", () => {
    expect(operatorOnlyRoutes()).toEqual([
      "POST /v1/ai-provider/approval",
      "POST /v1/job-sources/employer-list/approve",
      "PUT /v1/job-sources/remote-boards/{key}/enabled",
      "PUT /v1/job-sources/remote-boards/{key}/verification",
    ])
  })

  it("the A2 Operator-only paragraph names every @OperatorOnly route and says four", () => {
    expect(paragraph).not.toBe("")
    for (const route of operatorOnlyRoutes()) {
      const [method, path] = route.split(" ")
      expect(paragraph, route).toContain(`\`${method} ${path}\``)
    }
    expect(paragraph).toMatch(/\bfour\b/i)
    expect(paragraph).toMatch(/`PUT \/v1\/eligibility-settings` was the fifth until EPIC-0002 B1, v1\.25\.0, which removed it/)
  })

  it("the POST /v1/ai-provider/approval section documents the 404 for anyone but the Operator", () => {
    const section = /^### `POST \/v1\/ai-provider\/approval`$([\s\S]*?)^### /m.exec(contract)?.[1] ?? ""
    expect(section).toMatch(/^- \*\*Error responses:\*\* .*`404 not_found`.*Operator/m)
  })
})
