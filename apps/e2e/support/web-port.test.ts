import { strict as assert } from "node:assert"
import net from "node:net"
import { describe, it } from "node:test"

import { assertPortFree, DEFAULT_WEB_PORT, resolveWebPort, WEB_PORT_ENV } from "./web-port.ts"

/** FU-5: baseURL and the Vite server follow E2E_WEB_PORT, and setup never reuses a port someone else holds. */
describe("resolveWebPort (FU-5)", () => {
  it("defaults to 5199", () => {
    assert.equal(DEFAULT_WEB_PORT, 5199)
    assert.equal(resolveWebPort({}), 5199)
    assert.equal(resolveWebPort({ [WEB_PORT_ENV]: "" }), 5199)
  })

  it("reads E2E_WEB_PORT", () => {
    assert.equal(resolveWebPort({ [WEB_PORT_ENV]: "5299" }), 5299)
  })

  it("refuses a value that is not a TCP port", () => {
    for (const value of ["0", "65536", "-1", "52.5", "abc", " 5299", "5299x", "0x14b3"]) {
      assert.throws(() => resolveWebPort({ [WEB_PORT_ENV]: value }), new RegExp(WEB_PORT_ENV), value)
    }
  })
})

describe("assertPortFree (FU-5)", () => {
  it("throws when a server already listens on the port, and passes once it is closed", async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    try {
      await assert.rejects(assertPortFree(port), new RegExp(`Port ${port} is already in use on 127\\.0\\.0\\.1`))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await assert.doesNotReject(assertPortFree(port))
  })
})
