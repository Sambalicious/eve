import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req, Res } from "@nestjs/common"
import {
  DEFAULT_RETURN_PATH,
  SIGN_IN_PAGE_PATH,
  type SignInError,
  toSafeReturnPath,
} from "@eve/contracts"
import type { FastifyReply, FastifyRequest } from "fastify"

import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import {
  SESSION_COOKIE,
  SIGN_IN_ATTEMPT_COOKIE,
  clearCookieOptions,
  sessionCookieOptions,
  signInAttemptCookieOptions,
} from "./cookies.js"
import { Public } from "./public.decorator.js"
import { SessionService } from "./session.service.js"
import { SignInService } from "./sign-in.service.js"

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly signIn: SignInService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  /** Full-page navigation from the sign-in page. Redirects to Google. */
  @Public()
  @Get("google/start")
  async start(
    @Query("next") next: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const outcome = await this.signIn.start(next, request.cookies[SESSION_COOKIE])
    switch (outcome.kind) {
      case "already-signed-in":
        return this.redirectWithinDashboard(reply, outcome.returnPath)
      case "redirect-to-google":
        reply.setCookie(SIGN_IN_ATTEMPT_COOKIE, outcome.attemptId, signInAttemptCookieOptions)
        return this.sendRedirect(reply, outcome.googleUrl)
      case "failed":
        return this.redirectToSignIn(reply, "failed", outcome.returnPath)
      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }

  /** Google's redirect back after the account screen. */
  @Public()
  @Get("google/callback")
  async callback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const query = new URL(request.url, this.config.publicOrigin).searchParams
    const outcome = await this.signIn.complete(query, request.cookies[SIGN_IN_ATTEMPT_COOKIE])
    reply.clearCookie(SIGN_IN_ATTEMPT_COOKIE, clearCookieOptions)

    if (outcome.kind === "signed-in") {
      await this.sessions.end(request.cookies[SESSION_COOKIE])
      reply.setCookie(SESSION_COOKIE, outcome.sessionId, sessionCookieOptions)
      return this.redirectWithinDashboard(reply, outcome.returnPath)
    }
    return this.redirectToSignIn(reply, outcome.error, outcome.returnPath, outcome.email)
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.end(request.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, clearCookieOptions)
  }

  private redirectToSignIn(
    reply: FastifyReply,
    error: SignInError,
    returnPath: string,
    email?: string
  ): void {
    const params = new URLSearchParams({ error })
    if (email) params.set("email", email)
    params.set("next", toSafeReturnPath(returnPath))
    this.redirectWithinDashboard(reply, `${SIGN_IN_PAGE_PATH}?${params.toString()}`)
  }

  /**
   * Second line of defence behind toSafeReturnPath: a dashboard redirect whose
   * Location would resolve off PUBLIC_ORIGIN goes to the default page instead.
   */
  private redirectWithinDashboard(reply: FastifyReply, path: string): void {
    const target = new URL(path, this.config.publicOrigin)
    const onOrigin = target.origin === this.config.publicOrigin
    this.sendRedirect(reply, onOrigin ? target : new URL(DEFAULT_RETURN_PATH, this.config.publicOrigin))
  }

  private sendRedirect(reply: FastifyReply, location: URL): void {
    reply.header("cache-control", "no-store").redirect(location.href, HttpStatus.FOUND)
  }
}
