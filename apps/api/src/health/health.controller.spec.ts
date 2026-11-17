import "reflect-metadata"

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely"
import { describe, expect, it } from "vitest"

import type { Database } from "../db/schema.js"
import { ApiException } from "../http/api-exception.js"
import { HealthController } from "./health.controller.js"

class UnreachableDriver extends DummyDriver {
  override async acquireConnection(): Promise<never> {
    throw new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2")
  }
}

function databaseWith(driver: DummyDriver): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
}

describe("HealthController", () => {
  it("reports ok when the database answers", async () => {
    await expect(new HealthController(databaseWith(new DummyDriver())).check()).resolves.toEqual({ status: "ok", database: "ok" })
  })

  it("answers 503 service_unavailable when the database does not answer, without the driver's error text", async () => {
    const error = await new HealthController(databaseWith(new UnreachableDriver())).check().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiException)
    expect((error as ApiException).code).toBe("service_unavailable")
    expect((error as ApiException).getStatus()).toBe(503)
    expect(JSON.stringify((error as ApiException).getResponse())).not.toContain("hunter2")
  })
})
