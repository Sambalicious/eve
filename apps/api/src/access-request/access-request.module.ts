import { Module } from "@nestjs/common"

import { AccessRequestController } from "./access-request.controller.js"
import { AccessRequestRepository } from "./access-request.repository.js"
import { AccessRequestService } from "./access-request.service.js"

/** EPIC-0003: the public request-access endpoint, inside the api process. */
@Module({
  controllers: [AccessRequestController],
  providers: [AccessRequestService, AccessRequestRepository],
})
export class AccessRequestModule {}
