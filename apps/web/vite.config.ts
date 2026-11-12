import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

/**
 * The browser must see the API under /v1 on the dashboard's own origin
 * (api-contract.md, Base URL). In development Vite forwards /v1 to the api
 * process. Set the api's PUBLIC_ORIGIN to this dev server's origin.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000"

/**
 * `vite preview` serves the static contract DevOps implements in production
 * (EPIC-0003 architecture r1, "Static serving contract"): `/` and `/about` get
 * their prerendered files, existing files are served as is, and every other
 * path gets `app.html` (which keeps `noindex`). `/assets/*` is immutable.
 */
function staticContract(): Plugin {
  return {
    name: "eve-static-contract",
    configurePreviewServer(server) {
      const dist = path.resolve(import.meta.dirname, "dist")
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://preview")
        if (url.pathname.startsWith("/v1/")) return next()
        const file = path.join(dist, url.pathname)
        const isFile = file.startsWith(dist) && existsSync(file) && statSync(file).isFile()
        if (url.pathname.startsWith("/assets/") && isFile) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable")
          return next()
        }
        if (isFile && url.pathname !== "/index.html") {
          res.setHeader("cache-control", "no-cache")
          return next()
        }
        const page = url.pathname === "/" ? "index.html" : url.pathname === "/about" || url.pathname === "/about/" ? "about/index.html" : "app.html"
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.setHeader("cache-control", "no-cache")
        res.end(readFileSync(path.join(dist, page)))
      })
    },
  }
}

/**
 * Designer preview (dev server only, `EVE_PREVIEW=1`): app paths get
 * `preview.html`, which starts an MSW service worker with the contract fakes
 * before the app boots. The worker script is served from the msw package, so
 * nothing is added to `public/` or the build.
 */
function contractPreview(): Plugin {
  return {
    name: "eve-contract-preview",
    apply: "serve",
    configureServer(server) {
      if (process.env.EVE_PREVIEW !== "1") return
      const worker = path.resolve(import.meta.dirname, "node_modules/msw/lib/mockServiceWorker.js")
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://preview")
        if (url.pathname === "/mockServiceWorker.js") {
          res.setHeader("content-type", "text/javascript")
          res.setHeader("service-worker-allowed", "/")
          return res.end(readFileSync(worker))
        }
        const isAppPath = req.method === "GET" && !/^\/(@|src\/|node_modules\/|v1\/|assets\/)/.test(url.pathname) && !path.extname(url.pathname)
        if (isAppPath && (req.headers.accept ?? "").includes("text/html")) req.url = `/preview.html${url.search}`
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), staticContract(), contractPreview()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  define: {
    'import.meta.env.VITE_BASENAME': JSON.stringify(process.env.VITE_BASENAME || ''),
  },
  build: {
    // check:budget reads the manifest (architecture r1 section 3).
    manifest: true,
  },
  server: {
    proxy: {
      "/v1": { target: apiProxyTarget, xfwd: true },
    },
  },
  preview: {
    proxy: {
      "/v1": { target: apiProxyTarget, xfwd: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/shared/testing/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    restoreMocks: true,
    // Five seconds is a statement about an idle machine. Under load this suite produced a different
    // 5s timeout failure on each run, which reads as a regression.
    testTimeout: 15_000,
    // Per-test durations for flakiness reviews (not committed).
    reporters: ["default", ["json", { outputFile: "node_modules/.tmp/test-results.json" }]],
  },
})
