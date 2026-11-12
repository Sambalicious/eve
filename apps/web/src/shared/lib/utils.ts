// shadcn's class-name merger (clsx + tailwind-merge in one compiled package)
export { cn } from "cn"

/**
 * Get the correct URL for public assets
 * Handles both development and production asset paths
 */
export function assetUrl(path: string): string {
  const baseUrl = import.meta.env.BASE_URL || "/"
  const cleanPath = path.startsWith("/") ? path.slice(1) : path
  return baseUrl + cleanPath
}

/**
 * Get the correct URL path with basename prefix for internal navigation
 * @param path - The internal path (e.g., "/dashboard", "/auth/sign-in")
 * @returns The full path with basename prefix
 */
export function getAppUrl(path: string): string {
  const basename = import.meta.env.VITE_BASENAME || ""
  const cleanPath = path.startsWith("/") ? path : `/${path}`
  return basename + cleanPath
}
