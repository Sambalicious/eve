import { readFileSync } from "node:fs"

import { z } from "zod"

import type { BrowserConfig } from "../../worker/worker.config.js"
import { connectMcp } from "./mcp-caller.js"
import { PlaywrightFormSessions } from "./playwright-form-session.js"

const MCP_CALL_TIMEOUT_MS = 45_000
const RESULT_WAIT_SECONDS = 30

const reviewedHostsSchema = z.record(z.string(), z.array(z.string().regex(/^[a-z0-9.-]+$/i)).max(50))

/** The worker's Playwright MCP browser (ADR 0008). Only built when SUBMISSION_BROWSER_ENABLED=1. */
export function createPlaywrightFormSessions(config: BrowserConfig): PlaywrightFormSessions {
  const reviewedHosts = config.reviewedHostsFile ? reviewedHostsSchema.parse(JSON.parse(readFileSync(config.reviewedHostsFile, "utf8"))) : {}
  return new PlaywrightFormSessions({
    connect: (attemptId) => connectMcp({ url: config.mcpUrl, attemptId, timeoutMs: MCP_CALL_TIMEOUT_MS }),
    uploadDir: config.uploadDir,
    uploadDirInBrowser: config.uploadDirInBrowser,
    allowlistFile: config.allowlistFile,
    reviewedHosts,
    resultWaitSeconds: RESULT_WAIT_SECONDS,
  })
}
