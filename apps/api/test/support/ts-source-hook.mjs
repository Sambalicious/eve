// Test-only: lets the extraction child run from TypeScript source under Vitest, where
// `./x.js` imports refer to `./x.ts`. Production runs the compiled child from dist.
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      throw error
    }
  },
})
