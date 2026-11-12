import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { SP8, retiredIn } from "./stack-feed-copy.ts"

/** CR-E8-03: E8-24's retired-slot scan has no "Verified" exemption in recorded states. */
describe("retiredIn (E8-24, CR-E8-03)", () => {
  const recorded = "Permitted use recorded 28 Oct 2026\nUpdate"

  it("catches a reintroduced Verified badge next to the recorded line", () => {
    assert.deepEqual(retiredIn(`${recorded}\nVerified`), ["Verified"])
    assert.deepEqual(retiredIn(`Verified ${recorded}`), ["Verified"])
    assert.deepEqual(retiredIn(`${recorded} (Verified)`), ["Verified"])
  })

  it("finds nothing in the approved recorded and not-recorded strings", () => {
    assert.deepEqual(retiredIn(recorded), [])
    assert.deepEqual(retiredIn([SP8.feedsDesc, SP8.notVerifiedMessage, SP8.confirmTitle, SP8.feedsEmpty, SP8.postsUnverifiedNote].join("\n")), [])
  })

  it("matches Verified as a whole, case-sensitive word only", () => {
    assert.deepEqual(retiredIn("Unverified feeds"), [])
    assert.deepEqual(retiredIn("Verifiedness"), [])
    assert.deepEqual(retiredIn("verified"), [])
  })

  it("still catches the standalone retired row name and the other retired slots", () => {
    assert.deepEqual(retiredIn(`${SP8.feedsDesc}\nGoogle Alerts feeds`), ["Google Alerts feeds"])
    assert.deepEqual(retiredIn("Not verified"), ["Not verified"])
    assert.deepEqual(retiredIn("Record verification"), ["Record verification"])
  })
})
