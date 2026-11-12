/**
 * The Node fs call the motion-token test uses to read index.css (Vitest stubs
 * CSS imports, so `?raw` is empty there). Browser types only otherwise.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string
  /** Relative paths of every entry under `path` (the invalid-border scan). */
  export function readdirSync(path: string, options: { recursive: true }): string[]
}
