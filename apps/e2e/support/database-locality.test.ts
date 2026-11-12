import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { assertDisposableAdminUrl, REMOTE_DB_OPT_IN } from "./database-locality.ts"

/** SEC-P2-01: the fixtures run destructive superuser deletes, so the admin URL must be a local e2e database. */
describe("assertDisposableAdminUrl (SEC-P2-01)", () => {
  it("accepts a loopback e2e database", () => {
    for (const url of [
      "postgres://postgres:e2e-admin@127.0.0.1:55432/eve_e2e",
      "postgresql://u:p@localhost:5432/eve_e2e",
      "postgres://u:p@[::1]:5432/my_e2e_db",
      "postgres://u:p@LOCALHOST/eve_e2e?sslmode=disable",
    ]) {
      assert.doesNotThrow(() => assertDisposableAdminUrl(url, {}), url)
    }
  })

  it("refuses a remote host, a non-e2e database name or an unparsable URL", () => {
    for (const url of [
      "postgres://u:p@db.internal:5432/eve_e2e",
      "postgres://u:p@10.0.0.5:5432/eve_e2e",
      "postgres://u:p@127.0.0.1.evil.example:5432/eve_e2e",
      "postgres://u:p@localhost.evil.example/eve_e2e",
      "postgres://u:p@127.0.0.1:5432/eve",
      "postgres://u:p@127.0.0.1:5432/postgres",
      "postgres://u:p@127.0.0.1:5432/",
      "not a url",
    ]) {
      assert.throws(() => assertDisposableAdminUrl(url, {}), new RegExp(REMOTE_DB_OPT_IN), url)
    }
  })

  // SEC-H-01 / CR-H-01: pg-connection-string lets ?host= replace the URL authority.
  it("refuses a host or hostaddr query parameter in any letter case, even when it names a loopback host", () => {
    for (const url of [
      "postgres://u:p@127.0.0.1/eve_e2e?host=db.prod.internal",
      "postgres://u:p@localhost/eve_e2e?host=db.internal",
      "postgres://u:p@localhost/eve_e2e?host=127.0.0.1",
      "postgres://u:p@localhost/eve_e2e?host=/var/run/postgresql",
      "postgres://u:p@localhost/eve_e2e?sslmode=disable&host=db.internal",
      "postgres://u:p@localhost/eve_e2e?host=localhost&host=db.internal",
      "postgres://u:p@localhost/eve_e2e?%68ost=db.internal",
      "postgres://u:p@localhost/eve_e2e?hostaddr=10.0.0.5",
      "postgres://u:p@localhost/eve_e2e?hostaddr=127.0.0.1",
      "postgres://u:p@localhost/eve_e2e?HOST=db.internal",
      "postgres://u:p@localhost/eve_e2e?Host=db.internal",
      "postgres://u:p@localhost/eve_e2e?HostAddr=10.0.0.5",
      "postgres://u:p@localhost/eve_e2e?HOSTADDR=10.0.0.5",
    ]) {
      assert.throws(() => assertDisposableAdminUrl(url, {}), /host override query parameter/, url)
    }
  })

  // SEC-E2E-01 / INFO-A / QA INFO-1: pg honours ?port=, and libpq tools (psql, pg_dump,
  // pg-native) honour ?dbname=, ?service=, ?options= and ?passfile=. The authority and
  // path must be the only source of host, port and database.
  it("refuses port, dbname, database, service, options and passfile query parameters in any case or encoding", () => {
    for (const url of [
      "postgres://u:p@localhost/eve_e2e?port=6543",
      "postgres://u:p@127.0.0.1:55432/eve_e2e?port=55432",
      "postgres://u:p@localhost/eve_e2e?PORT=6543",
      "postgres://u:p@localhost/eve_e2e?%70ort=6543",
      "postgres://u:p@localhost/eve_e2e?dbname=prod",
      "postgres://u:p@localhost/eve_e2e?DbName=prod",
      "postgres://u:p@localhost/eve_e2e?db%6Eame=prod",
      "postgres://u:p@localhost/eve_e2e?database=prod",
      "postgres://u:p@localhost/eve_e2e?DATABASE=prod",
      "postgres://u:p@localhost/eve_e2e?service=prod",
      "postgres://u:p@localhost/eve_e2e?Service=prod",
      "postgres://u:p@localhost/eve_e2e?%73ervice=prod",
      "postgres://u:p@localhost/eve_e2e?options=-csearch_path%3Dprod",
      "postgres://u:p@localhost/eve_e2e?OPTIONS=-c%20x%3Dy",
      "postgres://u:p@localhost/eve_e2e?passfile=/tmp/pgpass",
      "postgres://u:p@localhost/eve_e2e?PassFile=/tmp/pgpass",
      "postgres://u:p@localhost/eve_e2e?sslmode=disable&dbname=prod",
      "postgresql://u:p@[::1]:5432/eve_e2e?service=prod",
    ]) {
      assert.throws(() => assertDisposableAdminUrl(url, {}), /connection override query parameter/, url)
    }
  })

  it("accepts the real default e2e admin URL, with the port in the authority", () => {
    for (const port of [5432, 55432, 65535]) {
      const url = `postgres://postgres:e2e-admin@127.0.0.1:${port}/eve_e2e`
      assert.doesNotThrow(() => assertDisposableAdminUrl(url, {}), url)
    }
  })

  it(`allows port, dbname, service, options and passfile overrides only when ${REMOTE_DB_OPT_IN}=1`, () => {
    for (const key of ["port", "dbname", "database", "service", "options", "passfile"]) {
      assert.doesNotThrow(() => assertDisposableAdminUrl(`postgres://u:p@localhost/eve_e2e?${key}=x`, { [REMOTE_DB_OPT_IN]: "1" }), key)
    }
  })

  it("refuses several hosts, an empty host and a non-postgres scheme", () => {
    for (const url of [
      "postgres://u:p@127.0.0.1,db.internal/eve_e2e",
      "postgres://u:p@localhost,127.0.0.1:5432/eve_e2e",
      "postgres://u:p@db.internal,localhost/eve_e2e",
      "postgres:///eve_e2e",
      "postgres://u:p@%2Fvar%2Frun%2Fpostgresql/eve_e2e",
      "socket:/var/run/postgresql?db=eve_e2e",
      "http://u:p@127.0.0.1/eve_e2e",
    ]) {
      assert.throws(() => assertDisposableAdminUrl(url, {}), new RegExp(REMOTE_DB_OPT_IN), url)
    }
  })

  it(`allows a host override only when ${REMOTE_DB_OPT_IN}=1`, () => {
    assert.doesNotThrow(() => assertDisposableAdminUrl("postgres://u:p@localhost/eve_e2e?host=db.internal", { [REMOTE_DB_OPT_IN]: "1" }))
  })

  it(`allows any URL only when ${REMOTE_DB_OPT_IN}=1`, () => {
    assert.doesNotThrow(() => assertDisposableAdminUrl("postgres://u:p@db.internal/eve", { [REMOTE_DB_OPT_IN]: "1" }))
    for (const value of ["", "0", "true", "yes"]) {
      assert.throws(() => assertDisposableAdminUrl("postgres://u:p@db.internal/eve", { [REMOTE_DB_OPT_IN]: value }), value)
    }
  })

  it("never puts the password in the error", () => {
    assert.throws(
      () => assertDisposableAdminUrl("postgres://u:SECRET-PASSWORD@db.internal/eve", {}),
      (error: Error) => !error.message.includes("SECRET-PASSWORD"),
    )
  })
})
