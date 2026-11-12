import type { INestApplication, Type } from "@nestjs/common"
import type { NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppModule } from "../../src/app.module.js"
import { EXTRACTION_CHILD } from "../../src/career-profile/resume-text.js"
import { TEST_EXTRACTION_CHILD } from "./extraction-child.js"
import { accessRequestKeys } from "../../src/access-request/access-request-keys.js"
import { type AccessRequestConfig, type AppConfig, anthropicConfig } from "../../src/config/env.js"
import { API_STATEMENT_TIMEOUT_MS } from "../../src/db/create-database.js"
import { STORAGE_MIGRATED_MARKER } from "../../src/files/candidate-files.js"
import { configureHttpApp, createFastifyAdapter } from "../../src/http/create-http-app.js"
import { CLOCK } from "../../src/shared/clock.js"
import { ALERT_FEED_HTTP } from "../../src/stack-posts/alert-feed-http.provider.js"
import type { AlertFeedHttp } from "../../src/stack-posts/alert-feed-http.js"
import { FORM_SESSION_FACTORY, type FormSessionFactory, unavailableFormSessions } from "../../src/submission/form-session.js"
import { QUESTION_SCHEMAS, type QuestionSchemaSource, noQuestionSchemas } from "../../src/submission/question-schema.js"
import { TEMPLATE_OPERATOR_SUB } from "./postgres-cluster.js"
import type { TestClock } from "./test-clock.js"

export const TEST_CLIENT_ID = "test-client.apps.googleusercontent.com"
export const TEST_CLIENT_SECRET = "test-client-secret"
export const PUBLIC_ORIGIN = "https://dashboard.test"
/** Google `sub` of "ada.okafor@gmail.com", bound to the Operator row by migration 0016 (test template). */
export const CANDIDATE_SUB = TEMPLATE_OPERATOR_SUB
export const CANDIDATE_EMAIL = "ada.okafor@gmail.com"
export const OTHER_SUB = "100000000000000000999"
export const OTHER_EMAIL = "someone.else@gmail.com"

/** Synthetic key; MSW checks it arrives as x-api-key. Never a real key. */
export const TEST_ANTHROPIC_KEY = "sk-ant-test-0000-SYNTHETIC-KEY-SENTINEL"
export const TEST_ANTHROPIC_MODEL = "claude-haiku-5-5"
/** Synthetic access-request secret (EPIC-0003). */
export const TEST_ACCESS_REQUEST_SECRET = "test-access-request-secret-0000-SYNTHETIC"

/** Defaults as in production behind Caddy: one trusted hop, 3/h, 10/day, 50/day. */
export function testAccessRequestConfig(overrides: Partial<Omit<AccessRequestConfig, "keys">> = {}): AccessRequestConfig {
  return {
    trustProxy: 1,
    limits: { perIpHour: 3, perIpDay: 10, globalDay: 50 },
    ...overrides,
    keys: accessRequestKeys(TEST_ACCESS_REQUEST_SECRET),
  }
}

type ConfigOverrides = Partial<Pick<AppConfig, "anthropic" | "candidateStorageDir" | "formAgentEnabled" | "documentBridgesEnabled" | "documentDirectionEnabled" | "statementTimeoutMs" | "accessRequest">>

/**
 * EPIC-0002 A2: a fresh per-Candidate file root under the OS temp directory,
 * already marked as migrated (boot refuses an unmigrated root). The default for
 * every test app that does not pass its own `candidateStorageDir`.
 */
export function migratedStorageRoot(prefix = "ja-files-"): string {
  return markStorageMigratedSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** Marks an existing test root as migrated (writes the storage:migrate marker) and returns it. */
export function markStorageMigratedSync(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, STORAGE_MIGRATED_MARKER), JSON.stringify({ version: 1, files: 0, completedAt: new Date(0).toISOString() }), { mode: 0o600 })
  return root
}

/** `<root>/<candidateId>/<area>`, created (0700): where CandidateFiles keeps that Candidate's files. */
export function candidateDir(root: string, candidateId: string, area: "resumes" | "documents"): string {
  const directory = join(root, candidateId, area)
  mkdirSync(join(root, candidateId), { recursive: true, mode: 0o700 })
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

export function testConfig(
  databaseUrl: string,
  overrides: ConfigOverrides = {}
): AppConfig {
  return {
    anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL),
    candidateStorageDir: overrides.candidateStorageDir ?? migratedStorageRoot(),
    // Off by default, as in compose; agent tests turn it on explicitly.
    formAgentEnabled: false,
    // EPIC-0012 (Revision 2, 2.4): both tailoring flags are off unless a test passes them on.
    documentBridgesEnabled: false,
    documentDirectionEnabled: false,
    accessRequest: testAccessRequestConfig(),
    ...overrides,
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl,
    publicOrigin: PUBLIC_ORIGIN,
    googleClientId: TEST_CLIENT_ID,
    googleClientSecret: TEST_CLIENT_SECRET,
    // Slice 8d (8d.9): the api's real value, so every api integration test runs under the 5 s timeout.
    // A test of worker-side code may pass the worker's value.
    statementTimeoutMs: overrides.statementTimeoutMs ?? API_STATEMENT_TIMEOUT_MS,
  }
}

/**
 * Boots the real api application on Fastify. Only the clock is replaced; extra
 * controllers let tests prove the global guard covers future /v1 routes.
 */
export async function createTestApp(options: {
  databaseUrl: string
  clock: TestClock
  extraControllers?: Type[]
  config?: ConfigOverrides
  /** Slice 5: the browser seam. Defaults to no browser, as in the api process. */
  formSessions?: FormSessionFactory
  /** Scope 05d: the ATS question schema reader. Defaults to none; tests never reach a real ATS API. */
  questionSchemas?: QuestionSchemaSource
  /** EPIC-0005: the Alert feed client, pointed at a local feed server. Defaults to the production client. */
  alertFeedHttp?: AlertFeedHttp
}): Promise<INestApplication> {
  // One config (and so one file root) for the module and the HTTP adapter.
  const config = testConfig(options.databaseUrl, options.config)
  const builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
    controllers: options.extraControllers ?? [],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock)
    .overrideProvider(EXTRACTION_CHILD)
    .useValue(TEST_EXTRACTION_CHILD)
    .overrideProvider(FORM_SESSION_FACTORY)
    .useValue(options.formSessions ?? unavailableFormSessions)
    .overrideProvider(QUESTION_SCHEMAS)
    .useValue(options.questionSchemas ?? noQuestionSchemas)
  if (options.alertFeedHttp) builder.overrideProvider(ALERT_FEED_HTTP).useValue(options.alertFeedHttp)
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(config))
  await configureHttpApp(app, config)
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}
