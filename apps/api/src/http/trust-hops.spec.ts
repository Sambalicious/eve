import Fastify from "fastify"
import { describe, expect, it } from "vitest"

import { trustHops } from "./create-http-app.js"

async function ipSeen(hops: number, forwardedFor?: string): Promise<string> {
  const app = Fastify({ trustProxy: trustHops(hops) })
  app.get("/ip", (request) => ({ ip: request.ip }))
  const response = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress: "10.0.0.2",
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  })
  await app.close()
  return (response.json() as { ip: string }).ip
}

describe("trustHops (EPIC-0003 client IP)", () => {
  it("0 ignores X-Forwarded-For", async () => {
    expect(await ipSeen(0, "198.51.100.9")).toBe("10.0.0.2")
  })

  it("1 takes the address the proxy appended", async () => {
    expect(await ipSeen(1, "198.51.100.9")).toBe("198.51.100.9")
  })

  it("1 ignores a visitor-forged entry in front of the proxy's (forged client-IP scenario)", async () => {
    // Caddy appends the real peer; a client-sent value stays to its left.
    expect(await ipSeen(1, "1.2.3.4, 198.51.100.9")).toBe("198.51.100.9")
  })

  it("1 without the header is the socket peer", async () => {
    expect(await ipSeen(1)).toBe("10.0.0.2")
  })
})
