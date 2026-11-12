import { CSRF_HEADER } from "@eve/contracts"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Browser } from "./browser.js"
import { CANDIDATE_EMAIL, CANDIDATE_SUB } from "./test-app.js"

/** A signed-in browser: GETs carry the cookie, state-changing calls also carry the CSRF token. */
export class SignedInCandidate {
  constructor(
    private readonly browser: Browser,
    readonly cookie: string,
    readonly csrfToken: string,
    readonly email: string
  ) {}

  get(path: string) {
    return this.browser.http().get(path).set("cookie", this.cookie)
  }

  post(path: string) {
    return this.browser.http().post(path).set("cookie", this.cookie).set(CSRF_HEADER, this.csrfToken)
  }

  put(path: string) {
    return this.browser.http().put(path).set("cookie", this.cookie).set(CSRF_HEADER, this.csrfToken)
  }

  patch(path: string) {
    return this.browser.http().patch(path).set("cookie", this.cookie).set(CSRF_HEADER, this.csrfToken)
  }

  delete(path: string) {
    return this.browser.http().delete(path).set("cookie", this.cookie).set(CSRF_HEADER, this.csrfToken)
  }
}

export async function signInCandidate(browser: Browser): Promise<SignedInCandidate> {
  const { sessionCookie } = await browser.signIn({ sub: CANDIDATE_SUB, email: CANDIDATE_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, CANDIDATE_EMAIL)
}
