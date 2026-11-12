/**
 * The one Node module the test setup imports. The app's tsconfig has browser
 * types only, so this declares just what setup.ts uses.
 */
declare module "node:buffer" {
  export const File: typeof globalThis.File
}
