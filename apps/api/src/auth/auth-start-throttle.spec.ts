import { describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../config/env.js"
import { TestClock } from "../../test/support/test-clock.js"
import { AuthController } from "./auth.controller.js"
import { SignInStartThrottle } from "./sign-in-start-throttle.js"
import type { SessionService } from "./session.service.js"
import type { SignInService } from "./sign-in.service.js"

function setup(trustProxy: number) {
  const start = vi.fn().mockResolvedValue({ kind: "redirect-to-google", googleUrl: "https://accounts.example/auth", attemptId: "a" })
  const signIn = { start } as unknown as SignInService
  const config = { accessRequest: { trustProxy }, publicOrigin: "http://localhost:5173" } as unknown as AppConfig
  const clock = new TestClock("2026-10-15T08:00:00Z")
  const controller = new AuthController(signIn, {} as SessionService, config, new SignInStartThrottle(config, clock))
  const hit = async (ip: string) => {
    const reply = { setCookie: vi.fn(), status: vi.fn().mockReturnThis(), redirect: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() }
    await controller.start("/home", { ip, cookies: {} } as never, reply as never)
    return reply
  }
  return { start, hit, clock }
}

describe("GET /v1/auth/google/start throttle", () => {
  it("behind a trusted proxy, refuses the 31st start from one address in a minute and sends it to sign-in", async () => {
    const { start, hit } = setup(1)
    for (let i = 0; i < 30; i++) await hit("203.0.113.7")
    const refused = await hit("203.0.113.7")
    expect(start).toHaveBeenCalledTimes(30)
    expect(JSON.stringify(refused.redirect.mock.calls)).toContain("sign-in")
  })

  it("keeps a separate budget for each address", async () => {
    const { start, hit } = setup(1)
    for (let i = 0; i < 30; i++) await hit("203.0.113.7")
    await hit("203.0.113.8")
    expect(start).toHaveBeenCalledTimes(31)
  })

  it("with TRUST_PROXY=0 shares one larger budget instead of locking visitors out at 30", async () => {
    const { start, hit } = setup(0)
    for (let i = 0; i < 31; i++) await hit(`10.0.0.${i}`)
    expect(start).toHaveBeenCalledTimes(31)
    for (let i = 0; i < 269; i++) await hit("10.0.0.99")
    const refused = await hit("10.0.0.100")
    expect(start).toHaveBeenCalledTimes(300)
    expect(JSON.stringify(refused.redirect.mock.calls)).toContain("sign-in")
  })

  it("lets the address start again once the minute has passed", async () => {
    const { start, hit, clock } = setup(1)
    for (let i = 0; i < 30; i++) await hit("203.0.113.7")
    await hit("203.0.113.7")
    clock.set("2026-10-15T08:01:01Z")
    await hit("203.0.113.7")
    expect(start).toHaveBeenCalledTimes(31)
  })
})
