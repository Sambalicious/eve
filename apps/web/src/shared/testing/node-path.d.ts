/**
 * The path helpers the copy-deck reader uses. The app's tsconfig has browser
 * types only, so this declares just what `copy-deck.ts` needs.
 */
declare module "node:path" {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
}
