import { parse } from "pg-connection-string"

/**
 * SEC-P2-01: the E2E fixtures connect as a superuser and run destructive deletes
 * (support/db.ts resetPostings). In E2E_BASE_URL mode the admin URL comes from
 * the environment, so refuse anything that is not a loopback database whose name
 * contains "e2e", unless the caller opts in explicitly.
 *
 * SEC-H-01 / CR-H-01: `pg` reads the URL with pg-connection-string, where a
 * `?host=` query parameter replaces the URL authority. So the check reads the
 * host and database from the same parser `pg` uses, and refuses any `host` or
 * `hostaddr` query parameter (in any letter case), a list of hosts, an empty host
 * (pg would fall back to PGHOST) and anything that is not a postgres:// URL.
 *
 * SEC-E2E-01 / INFO-A / QA INFO-1: `pg` also honours `?port=`, and libpq tools
 * (psql, pg_dump, pg-native) honour `?dbname=`, `?service=`, `?options=` and
 * `?passfile=`. Refuse those keys too (any case; URLSearchParams decodes
 * percent-encoded keys), so the authority and path are the only source of the
 * host, port and database. The default URL keeps its port in the authority.
 */
export const REMOTE_DB_OPT_IN = "E2E_ALLOW_REMOTE_DB"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])
const HOST_OVERRIDE_PARAMS = new Set(["host", "hostaddr"])
const CONNECTION_OVERRIDE_PARAMS = new Set(["port", "dbname", "database", "service", "options", "passfile"])

export function assertDisposableAdminUrl(adminUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env[REMOTE_DB_OPT_IN] === "1") return
  let url: URL
  let host: string
  let database: string
  try {
    url = new URL(adminUrl)
    const parsed = parse(adminUrl)
    host = (parsed.host ?? "").toLowerCase()
    database = parsed.database ?? ""
  } catch {
    throw new Error(`E2E admin database URL cannot be parsed. Set ${REMOTE_DB_OPT_IN}=1 to skip the locality check.`)
  }
  const refuse = (reason: string): never => {
    throw new Error(
      `E2E admin database must be on 127.0.0.1, localhost or ::1 and its name must contain "e2e" (${reason}). ` +
        `The fixtures delete data as a superuser. Set ${REMOTE_DB_OPT_IN}=1 only for a disposable database.`,
    )
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") refuse(`got scheme "${url.protocol}"`)
  const overrides = [...url.searchParams.keys()].filter((key) => HOST_OVERRIDE_PARAMS.has(key.toLowerCase()))
  if (overrides.length > 0) refuse(`the URL has a host override query parameter: ${overrides.join(", ")}`)
  const connectionOverrides = [...url.searchParams.keys()].filter((key) => CONNECTION_OVERRIDE_PARAMS.has(key.toLowerCase()))
  if (connectionOverrides.length > 0) refuse(`the URL has a connection override query parameter: ${connectionOverrides.join(", ")}`)
  if (host.includes(",")) refuse(`got several hosts "${host}"`)
  if (!LOOPBACK_HOSTS.has(host) || !database.toLowerCase().includes("e2e")) refuse(`got host "${host}", database "${database}"`)
}
