import { createHash } from "node:crypto"

import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

export const GOOGLE_ISSUER = "https://accounts.google.com"
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"
const KEY_ID = "fake-google-key-1"

export type IdTokenClaims = {
  sub: string
  email?: string
  email_verified?: boolean
  iss?: string
  aud?: string
  nonce?: string
  /** Seconds since epoch. */
  exp?: number
  iat?: number
}

type PendingCode = { codeChallenge: string; claims: IdTokenClaims }

/**
 * Stands in for Google's HTTP endpoints only: discovery, JWKS, and the token
 * endpoint. It signs real RS256 ID tokens so openid-client verifies them for
 * real. Tests act as the browser and Google's account screen.
 */
export class FakeGoogle {
  readonly server: ReturnType<typeof setupServer>
  readonly unexpectedRequests: string[] = []
  readonly tokenRequests: URLSearchParams[] = []
  private readonly codes = new Map<string, PendingCode>()
  private codeCounter = 0

  private constructor(
    private readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
    publicJwk: Record<string, unknown>,
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {
    this.server = setupServer(
      http.get(`${GOOGLE_ISSUER}/.well-known/openid-configuration`, () =>
        HttpResponse.json({
          issuer: GOOGLE_ISSUER,
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          jwks_uri: JWKS_URI,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        })
      ),
      http.get(JWKS_URI, () =>
        HttpResponse.json({ keys: [{ ...publicJwk, kid: KEY_ID, alg: "RS256", use: "sig" }] })
      ),
      http.post(TOKEN_ENDPOINT, async ({ request }) => this.handleToken(request)),
      // Any other HTTPS call would leave the machine: fail it and record it.
      http.all(/^https:\/\//, ({ request }) => {
        this.unexpectedRequests.push(`${request.method} ${request.url}`)
        return HttpResponse.error()
      })
    )
  }

  static async create(clientId: string, clientSecret: string): Promise<FakeGoogle> {
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    return new FakeGoogle(privateKey, await exportJWK(publicKey), clientId, clientSecret)
  }

  listen(): void {
    // Supertest talks to the app over plain-HTTP loopback; let that through.
    this.server.listen({ onUnhandledFrame: "bypass" })
  }

  close(): void {
    this.server.close()
  }

  reset(): void {
    this.codes.clear()
    this.tokenRequests.length = 0
    this.unexpectedRequests.length = 0
  }

  /**
   * Plays Google's account screen: reads the authorization URL the backend
   * produced, and returns the callback query Google would redirect with.
   * `claims` defaults the nonce to the one the backend sent.
   */
  approve(authorizationUrl: URL, claims: IdTokenClaims): URLSearchParams {
    const code = `code-${++this.codeCounter}`
    const nonce = authorizationUrl.searchParams.get("nonce") ?? undefined
    this.codes.set(code, {
      codeChallenge: authorizationUrl.searchParams.get("code_challenge") ?? "",
      claims: { nonce, ...claims },
    })
    return new URLSearchParams({
      code,
      state: authorizationUrl.searchParams.get("state") ?? "",
    })
  }

  /** Plays the Candidate pressing Cancel on Google's account screen. */
  cancel(authorizationUrl: URL): URLSearchParams {
    return new URLSearchParams({
      error: "access_denied",
      state: authorizationUrl.searchParams.get("state") ?? "",
    })
  }

  private async handleToken(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    this.tokenRequests.push(form)
    const pending = this.codes.get(form.get("code") ?? "")
    if (!pending) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
    if (!this.isClientAuthenticated(request, form)) {
      return HttpResponse.json({ error: "invalid_client" }, { status: 401 })
    }
    if (s256(form.get("code_verifier") ?? "") !== pending.codeChallenge) {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
    }
    this.codes.delete(form.get("code") ?? "")
    return HttpResponse.json({
      access_token: "fake-access-token",
      token_type: "Bearer",
      expires_in: 3599,
      scope: "openid email",
      id_token: await this.signIdToken(pending.claims),
    })
  }

  private isClientAuthenticated(request: Request, form: URLSearchParams): boolean {
    const basic = request.headers.get("authorization")
    if (basic?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(basic.slice(6), "base64").toString().split(":")
      return (
        decodeURIComponent(id ?? "") === this.clientId &&
        decodeURIComponent(secret ?? "") === this.clientSecret
      )
    }
    return form.get("client_id") === this.clientId && form.get("client_secret") === this.clientSecret
  }

  private async signIdToken(claims: IdTokenClaims): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const { iss, aud, exp, iat, ...rest } = claims
    return new SignJWT({ ...rest, azp: this.clientId })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
      .setIssuer(iss ?? GOOGLE_ISSUER)
      .setAudience(aud ?? this.clientId)
      .setIssuedAt(iat ?? nowSeconds)
      .setExpirationTime(exp ?? nowSeconds + 3600)
      .sign(this.privateKey)
  }
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}
