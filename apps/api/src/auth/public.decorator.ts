import { SetMetadata } from "@nestjs/common"

export const IS_PUBLIC = "auth:isPublic"
export const IS_PUBLIC_WRITE = "auth:isPublicWrite"

/**
 * Marks a route that the global auth guard lets through without a session.
 * Honoured on safe methods (GET, HEAD, OPTIONS) only: a `@Public()` POST still
 * needs a session and the CSRF token.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true)

/**
 * The one unauthenticated write (EPIC-0003, `POST /v1/public/access-requests`).
 * The guard lets it through without reading the cookie only when the public
 * write gate already passed its Origin, media type and size checks. A second
 * use must change test/public-routes.int-spec.ts and go through Security review.
 */
export const PublicWrite = () => SetMetadata(IS_PUBLIC_WRITE, true)
