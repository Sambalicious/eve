import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * C36 (gherkin data-isolation.feature @ac-6.11 @slice-A1, "Only the access-request
 * module, its sender branch and its retention jobs open the installation scope"):
 * each probe is linted as if it were the named source file.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const eslint = new ESLint({ cwd: API_ROOT })
const PROBE = `import type { TenantDatabase } from "../db/tenant-database.js"\nexport const run = (tenant: TenantDatabase) => tenant.forInstallation(async () => 1)\n`
const MESSAGE = /installation scope \(C36/

async function installationMessages(file: string): Promise<string[]> {
  const [result] = await eslint.lintText(PROBE, { filePath: `${API_ROOT}${file}` })
  return result!.messages.filter((message) => message.ruleId === "no-restricted-syntax" && MESSAGE.test(message.message)).map((message) => message.message)
}

describe("installation-scope lint rule (C36)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}src/db/warm-up.ts` })
  }, 120_000)

  it.each([
    "src/notification/notification.repository.ts",
    "src/notification/notification-status.service.ts",
    "src/discovery/discovery.repository.ts",
    "src/records/records.service.ts",
    "src/stack-posts/stack-posts.repository.ts",
    "src/worker/notification-jobs.ts",
  ])("fails when %s opens the installation scope", async (file) => {
    expect(await installationMessages(file)).toHaveLength(1)
  })

  it.each([
    "src/access-request/access-request.repository.ts",
    "src/notification/access-request-outbox.repository.ts",
    "src/worker/access-request-jobs.ts",
  ])("passes in %s", async (file) => {
    expect(await installationMessages(file)).toEqual([])
  })
})
