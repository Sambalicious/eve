import { Inject, Injectable } from "@nestjs/common"
import { SIGN_IN_CALLBACK_PATH } from "@eve/contracts"
import * as oidc from "openid-client"

import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import type { VerifiedIdentity } from "./sign-in-decision.js"

export const GOOGLE_ISSUER = new URL("https://accounts.google.com")
const SCOPE = "openid email"

export type AuthorizationRequest = Readonly<{
  url: URL
  state: string
  nonce: string
  codeVerifier: string
}>

export type CallbackChecks = Readonly<{
  state: string
  nonce: string
  codeVerifier: string
}>

/**
 * Adapter over openid-client for Google's authorization code flow with PKCE.
 * The library verifies the ID token signature (JWKS), iss, aud, azp, exp, iat,
 * and nonce. Discovery runs on first use and is cached for the process.
 */
@Injectable()
export class GoogleOidcClient {
  private configuration: Promise<oidc.Configuration> | undefined

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    const configuration = await this.getConfiguration()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri(),
      scope: SCOPE,
      response_type: "code",
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
      prompt: "select_account",
    })
    return { url, state, nonce, codeVerifier }
  }

  /** Exchanges the code and returns the verified identity. Throws on any failed check. */
  async completeAuthorization(
    callbackQuery: URLSearchParams,
    checks: CallbackChecks
  ): Promise<VerifiedIdentity> {
    const configuration = await this.getConfiguration()
    const currentUrl = new URL(this.redirectUri())
    currentUrl.search = callbackQuery.toString()
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    if (!claims) throw new Error("Token response has no ID token")
    return {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      emailVerified: claims.email_verified === true,
    }
  }

  private redirectUri(): string {
    return `${this.config.publicOrigin}${SIGN_IN_CALLBACK_PATH}`
  }

  private getConfiguration(): Promise<oidc.Configuration> {
    this.configuration ??= this.discover().catch((error: unknown) => {
      this.configuration = undefined
      throw error
    })
    return this.configuration
  }

  private async discover(): Promise<oidc.Configuration> {
    const configuration = await oidc.discovery(
      GOOGLE_ISSUER,
      this.config.googleClientId,
      this.config.googleClientSecret
    )
    oidc.enableNonRepudiationChecks(configuration)
    return configuration
  }
}
