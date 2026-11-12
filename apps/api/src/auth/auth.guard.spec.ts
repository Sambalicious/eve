import type { ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { describe, expect, it, vi } from "vitest"

import { AuthGuard } from "./auth.guard.js"
import { IS_PUBLIC, IS_PUBLIC_WRITE } from "./public.decorator.js"
import type { SessionService } from "./session.service.js"

function contextFor(method: string, flags: Record<string, boolean>, request: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => undefined
  for (const [key, value] of Object.entries(flags)) Reflect.defineMetadata(key, value, handler)
  const req = { method, cookies: {}, headers: {}, ...request }
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

const missingSession = { resume: vi.fn(async () => ({ kind: "missing" as const })) } as unknown as SessionService

describe("AuthGuard public rules (architecture.r1 7.2)", () => {
  const guard = new AuthGuard(new Reflector(), missingSession)

  it("@Public() GET passes without a session", async () => {
    await expect(guard.canActivate(contextFor("GET", { [IS_PUBLIC]: true }))).resolves.toBe(true)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE"])("@Public() %s still needs a session", async (method) => {
    await expect(guard.canActivate(contextFor(method, { [IS_PUBLIC]: true }))).rejects.toMatchObject({ code: "unauthenticated" })
  })

  it("@PublicWrite() passes only with the gate's flag, and never reads the cookie", async () => {
    const resume = vi.fn()
    const strict = new AuthGuard(new Reflector(), { resume } as unknown as SessionService)
    await expect(strict.canActivate(contextFor("POST", { [IS_PUBLIC_WRITE]: true }, { publicWriteChecked: true }))).resolves.toBe(true)
    expect(resume).not.toHaveBeenCalled()
  })

  it("@PublicWrite() without the gate's flag fails closed with origin_forbidden", async () => {
    await expect(guard.canActivate(contextFor("POST", { [IS_PUBLIC_WRITE]: true }))).rejects.toMatchObject({ code: "origin_forbidden" })
  })
})
