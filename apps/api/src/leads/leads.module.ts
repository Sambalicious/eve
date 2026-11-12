import { Module } from "@nestjs/common"

import { LeadsController } from "./leads.controller.js"
import { LeadsRepository } from "./leads.repository.js"
import { LeadsService } from "./leads.service.js"

/** v1.29.0 lead pipeline (owner decision 2026-11-10). api process only. */
@Module({
  controllers: [LeadsController],
  providers: [LeadsRepository, LeadsService],
})
export class LeadsModule {}
