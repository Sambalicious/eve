import { Controller, Get, Inject } from "@nestjs/common"
import type { HealthResponse } from "@eve/contracts"
import { type Kysely } from "kysely"
import { sql } from "../db/sql.js"

import { Public } from "../auth/public.decorator.js"
import { DATABASE } from "../db/database.module.js"
import type { Database } from "../db/schema.js"
import { ApiException } from "../http/api-exception.js"

@Controller("v1/health")
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  @Public()
  @Get()
  async check(): Promise<HealthResponse> {
    try {
      await sql`select 1`.execute(this.db)
    } catch {
      throw new ApiException("service_unavailable")
    }
    return { status: "ok", database: "ok" }
  }
}
