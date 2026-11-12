import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"

import pg from "pg"

import { assertDisposableAdminUrl } from "./database-locality.ts"
import { ADA, BOLA, E2E_DIR, REPO_ROOT, STATE_FILE, type StackState } from "./stack.ts"
import { assertPortFree, resolveWebPort } from "./web-port.ts"

/** Vite's default dependency optimizer cache for apps/web (no cacheDir in its vite.config.ts). */
const WEB_VITE_CACHE_DIR = path.join(REPO_ROOT, "apps/web/node_modules/.vite")

/**
 * Starts the isolated real stack the journeys run against, unless E2E_BASE_URL
 * is set (then E2E_DATABASE_ADMIN_URL and E2E_OUTBOUND_LOG must be set too and
 * nothing is started). The admin URL must be a loopback database whose name
 * contains "e2e" unless E2E_ALLOW_REMOTE_DB=1 (SEC-P2-01).
 *
 *   1. Postgres 17 in a throwaway Docker container (`docker run --rm`).
 *   2. Builds @eve/contracts and @eve/api, provisions the owner and runtime roles
 *      and runs every migration, binding the Operator to ADA.sub (migration 0016).
 *   3. Adds BOLA as an onboarded invited Candidate, then runs storage:migrate
 *      (EPIC-0002 A2) over empty pre-A2 flat directories so the per-Candidate
 *      root gets its marker; the api refuses to start without it.
 *   4. Starts support/feed-stand-in.mjs (EPIC-0007 Phase 3: the loopback stand-in
 *      for Google Alerts feed URLs), then the built api with
 *      support/outbound-stub.mjs preloaded and ALERT_FEED_TEST_ORIGIN pointing
 *      at the stand-in.
 *   5. Clears apps/web's Vite dependency cache, then starts the Vite dev server
 *      for apps/web on E2E_WEB_PORT (default 5199, --strictPort, --force),
 *      proxying /v1 to that api. Setup refuses to start when
 *      anything already listens on that port (FU-5).
 *
 * Returns a teardown that stops the processes and removes the container with its
 * anonymous volume.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  if (process.env.E2E_BASE_URL) {
    const adminUrl = required("E2E_DATABASE_ADMIN_URL")
    assertDisposableAdminUrl(adminUrl)
    const outboundLog = required("E2E_OUTBOUND_LOG")
    const feedStandInOrigin = process.env.E2E_FEED_STAND_IN_ORIGIN ?? null
    writeState({ baseUrl: process.env.E2E_BASE_URL, adminUrl, outboundLog, feedStandInOrigin, pids: [], containerId: null })
    return async () => {}
  }

  // FU-5: fail before any Docker or build work if another process (another
  // worktree's Vite, say) already listens on the web port.
  const webPort = resolveWebPort()
  await assertPortFree(webPort)
  const baseUrl = `http://localhost:${webPort}`
  process.stdout.write(`e2e: web server port ${webPort}, baseURL ${baseUrl}\n`)

  const children: ChildProcess[] = []
  let containerId: string | null = null
  const teardown = async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM")
    // -v: `docker rm -f` bypasses --rm's cleanup, so remove the anonymous PGDATA volume too.
    if (containerId) execFileSync("docker", ["rm", "-f", "-v", containerId], { stdio: "ignore" })
  }

  try {
    containerId = execFileSync(
      "docker",
      ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=e2e-admin", "-e", "POSTGRES_DB=eve_e2e", "-p", "127.0.0.1::5432", "postgres:17-alpine"],
      { encoding: "utf8" }
    ).trim()
    const hostPort = execFileSync("docker", ["port", containerId, "5432/tcp"], { encoding: "utf8" }).trim().split(":").pop()
    const adminUrl = `postgres://postgres:e2e-admin@127.0.0.1:${hostPort}/eve_e2e`
    await waitForPostgres(adminUrl)

    execFileSync("pnpm", ["--filter", "@eve/contracts", "build"], { cwd: REPO_ROOT, stdio: "inherit" })
    execFileSync("pnpm", ["--filter", "@eve/api", "build"], { cwd: REPO_ROOT, stdio: "inherit" })
    const apiDir = path.join(REPO_ROOT, "apps/api")
    const roles = { owner: ["eve_owner", "e2e-owner-password"], runtime: ["eve_runtime", "e2e-runtime-password"] } as const
    execFileSync("node", ["dist/db/provision-roles.cli.js"], {
      cwd: apiDir,
      stdio: "inherit",
      env: { ...process.env, ADMIN_DATABASE_URL: adminUrl, POSTGRES_DB: "eve_e2e", DB_OWNER_ROLE: roles.owner[0], DB_OWNER_PASSWORD: roles.owner[1], DB_RUNTIME_ROLE: roles.runtime[0], DB_RUNTIME_PASSWORD: roles.runtime[1] },
    })
    execFileSync("node", ["dist/db/migrate.cli.js"], {
      cwd: apiDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: `postgres://${roles.owner[0]}:${roles.owner[1]}@127.0.0.1:${hostPort}/eve_e2e`, RUNTIME_DATABASE_ROLE: roles.runtime[0], CANDIDATE_GOOGLE_SUB: ADA.sub },
    })
    await seedIdentities(adminUrl)

    // EPIC-0002 A2: files live under CANDIDATE_STORAGE_DIR/<candidate_id>/; the api
    // refuses RESUME_STORAGE_DIR/DOCUMENT_STORAGE_DIR and refuses to start until
    // storage:migrate has written its marker (docs/ops/deploy.md). Fresh root per run.
    const storageDir = path.join(E2E_DIR, "test-results", "storage")
    const candidateStorageDir = path.join(storageDir, "candidates")
    rmSync(storageDir, { recursive: true, force: true })
    // F-SEC-41: owner-only, like the layout CandidateFiles creates in production.
    for (const dir of [storageDir, ...["old-resumes", "old-documents", "candidates"].map((name) => path.join(storageDir, name))]) makeOwnerOnlyDir(dir)
    execFileSync("node", ["dist/db/storage-migrate.cli.js"], {
      cwd: apiDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `postgres://${roles.owner[0]}:${roles.owner[1]}@127.0.0.1:${hostPort}/eve_e2e`,
        OLD_RESUME_STORAGE_DIR: path.join(storageDir, "old-resumes"),
        OLD_DOCUMENT_STORAGE_DIR: path.join(storageDir, "old-documents"),
        CANDIDATE_STORAGE_DIR: candidateStorageDir,
      },
    })

    const apiPort = await freePort()
    const outboundLog = path.join(E2E_DIR, "test-results", "api-outbound.jsonl")
    writeFileSync(outboundLog, "")

    // EPIC-0007 Phase 3 (declared double): the only loopback host the api's Alert feed
    // client may reach in place of https://www.google.com/alerts/feeds/… (EPIC-0005 seam
    // SEC-E5-04). outbound-stub.mjs already lets loopback through and still fails every
    // other non-loopback host, so no live Google request can happen.
    const feedPort = await freePort()
    const feedStandInOrigin = `http://127.0.0.1:${feedPort}`
    children.push(spawn("node", [path.join(E2E_DIR, "support/feed-stand-in.mjs")], { stdio: "inherit", env: { ...process.env, FEED_STAND_IN_PORT: String(feedPort) } }))
    await waitForHttp(`${feedStandInOrigin}/__control/requests`)

    children.push(
      spawn("node", ["--import", path.join(E2E_DIR, "support/outbound-stub.mjs"), "dist/main.api.js"], {
        cwd: apiDir,
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "test",
          HOST: "127.0.0.1",
          PORT: String(apiPort),
          DATABASE_URL: `postgres://${roles.runtime[0]}:${roles.runtime[1]}@127.0.0.1:${hostPort}/eve_e2e`,
          PUBLIC_ORIGIN: baseUrl,
          GOOGLE_CLIENT_ID: "e2e-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "e2e-client-secret",
          ANTHROPIC_API_KEY: "",
          MASTRA_TELEMETRY_DISABLED: "1",
          ACCESS_REQUEST_SECRET: "e2e-access-request-secret-0000-SYNTHETIC",
          CANDIDATE_STORAGE_DIR: candidateStorageDir,
          E2E_OUTBOUND_LOG: outboundLog,
          ALERT_FEED_TEST_ORIGIN: feedStandInOrigin,
          ALERT_FEED_TEST_ORIGIN_ENABLED: "1",
        },
      })
    )
    await waitForHttp(`http://127.0.0.1:${apiPort}/v1/health`)

    // QG-12: a stale dependency optimizer cache can serve two copies of React.
    // apps/web/vite.config.ts sets no cacheDir, so the cache is Vite's default
    // <root>/node_modules/.vite. Remove it, and pass --force so Vite re-bundles
    // even if a cacheDir is configured later.
    rmSync(WEB_VITE_CACHE_DIR, { recursive: true, force: true })
    process.stdout.write(`e2e: cleared Vite dependency cache ${path.relative(REPO_ROOT, WEB_VITE_CACHE_DIR)}\n`)

    // Checked again here: the port may have been taken during the build.
    await assertPortFree(webPort)
    // --strictPort: exit instead of moving to the next port, so baseURL never points at a server we did not start.
    const vite = spawn("pnpm", ["--filter", "@eve/web", "exec", "vite", "--host", "localhost", "--port", String(webPort), "--strictPort", "--force"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    })
    children.push(vite)
    await waitForHttp(`${baseUrl}/`, 120_000, vite)

    writeState({ baseUrl, adminUrl, outboundLog, feedStandInOrigin, pids: children.map((child) => child.pid ?? 0), containerId })
    return teardown
  } catch (error) {
    await teardown()
    throw error
  }
}

async function seedIdentities(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    // The Operator row exists (0016 bound it to ADA.sub); give it ADA's email and keep it onboarded.
    await client.query("update candidate set email = $1, onboarded_at = coalesce(onboarded_at, now()) where google_sub = $2", [ADA.email, ADA.sub])
    await client.query(
      "insert into candidate (email, google_sub, role, onboarded_at) values ($1, $2, 'candidate', now()) on conflict (google_sub) do nothing",
      [BOLA.email, BOLA.sub]
    )
    // QA-G-01: the per-Candidate job_criteria row the api fixtures give every second Candidate
    // (apps/api/test/candidate-posting-isolation.int-spec.ts, qa-two-candidate-postings.int-spec.ts).
    await client.query(
      "insert into job_criteria (candidate_id, min_core_match_percent) select id, 70 from candidate where google_sub = $1 on conflict (candidate_id) do nothing",
      [BOLA.sub]
    )
  } finally {
    await client.end()
  }
}

/** mkdir with mode 0700, then chmod (the umask can only narrow the mkdir mode) and check it. */
function makeOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const mode = statSync(dir).mode & 0o777
  if (mode !== 0o700) throw new Error(`${dir} has mode ${mode.toString(8)}, expected 700`)
}

function writeState(state: StackState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state))
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when E2E_BASE_URL is set`)
  return value
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query("select 1")
      await client.end()
      return
    } catch (error) {
      await client.end().catch(() => {})
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/** Polls until `url` answers. With `owner`, fails as soon as that process exits, so nothing else on the port can answer for it. */
async function waitForHttp(url: string, timeoutMs = 120_000, owner?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (owner && (owner.exitCode !== null || owner.signalCode !== null)) {
      throw new Error(`The process serving ${url} exited (${owner.exitCode ?? owner.signalCode}) before it was ready`)
    }
    try {
      const response = await fetch(url)
      if (response.status < 500) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
