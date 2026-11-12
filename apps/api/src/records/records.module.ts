import { Module } from "@nestjs/common"

import { RecordsController } from "./records.controller.js"
import { RecordsService } from "./records.service.js"
import { RetentionService } from "./retention.service.js"

/** Manual Outcomes, deletion of detailed records and the retention facts (api only). */
@Module({
  controllers: [RecordsController],
  providers: [RecordsService, RetentionService],
})
export class RecordsModule {}
