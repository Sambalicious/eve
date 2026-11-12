import type { INestApplication } from "@nestjs/common"
import request from "supertest"

import { SESSION_COOKIE, SIGN_IN_ATTEMPT_COOKIE } from "../../src/auth/cookies.js"
import type { FakeGoogle, IdTokenClaims } from "./fake-google.js"

export type Cookies = Record<string, string>

export type StartedSignIn = { authorizationUrl: URL; attemptCookie: string }

/** Reads `name=value` pairs from Set-Cookie headers; an empty value means cleared. */
export function readSetCookies(response: request.Response): Cookies {
  const header = response.headers["set-cookie"] as unknown
  const lines = Array.isArray(header) ? (header as string[]) : []
  const cookies: Cookies = {}
  for (const line of lines) {
    const [pair = ""] = line.split(";")
    const separator = pair.indexOf("=")
    cookies[pair.slice(0, separator)] = pair.slice(separator + 1)
  }
  return cookies
}

export function setCookieLine(response: request.Response, name: string): string | undefined {
  const header = response.headers["set-cookie"] as unknown
  const lines = Array.isArray(header) ? (header as string[]) : []
  return lines.find((line) => line.startsWith(`${name}=`))
}

export function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

/** Drives the browser side of sign-in against the real app. */
export class Browser {
  constructor(
    private readonly app: INestApplication,
    private readonly google: FakeGoogle
  ) {}

  http() {
    return request(this.app.getHttpServer())
  }

  async startSignIn(next?: string, cookies: Cookies = {}): Promise<StartedSignIn> {
    const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`
    const response = await this.http()
      .get(`/v1/auth/google/start${query}`)
      .set("cookie", cookieHeader(cookies))
      .expect(302)
    const attemptCookie = readSetCookies(response)[SIGN_IN_ATTEMPT_COOKIE]
    if (!attemptCookie) throw new Error(`No sign-in attempt cookie; Location ${response.headers.location}`)
    return { authorizationUrl: new URL(response.headers.location as string), attemptCookie }
  }

  callback(query: URLSearchParams, attemptCookie: string | undefined, cookies: Cookies = {}) {
    const all = attemptCookie ? { ...cookies, [SIGN_IN_ATTEMPT_COOKIE]: attemptCookie } : cookies
    return this.http().get(`/v1/auth/google/callback?${query.toString()}`).set("cookie", cookieHeader(all))
  }

  /** Full happy-path sign-in. Returns the session cookie and the final redirect. */
  async signIn(claims: IdTokenClaims, next?: string): Promise<{ sessionCookie: string; location: string }> {
    const started = await this.startSignIn(next)
    const response = await this.callback(
      this.google.approve(started.authorizationUrl, claims),
      started.attemptCookie
    ).expect(302)
    const sessionCookie = readSetCookies(response)[SESSION_COOKIE]
    if (!sessionCookie) throw new Error(`Sign-in did not set a session; Location ${response.headers.location}`)
    return { sessionCookie, location: response.headers.location as string }
  }

  getSession(sessionCookie?: string) {
    const call = this.http().get("/v1/session")
    return sessionCookie ? call.set("cookie", `${SESSION_COOKIE}=${sessionCookie}`) : call
  }
}
