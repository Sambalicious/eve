import { Module } from "@nestjs/common"

import { CareerProfileModule } from "../career-profile/career-profile.module.js"
import { SubmissionModule } from "../submission/submission.module.js"
import { AddedFactsController } from "./added-facts.controller.js"
import { AddedFactsRepository } from "./added-facts.repository.js"
import { AddedFactsService } from "./added-facts.service.js"

/**
 * FEAT-0017: Application-scoped added facts. The routes exist only behind
 * `ADDED_FACTS_ENABLED=1` (the `onRequest` path gate answers 404 when it is off);
 * the module itself is always registered so a flag flip needs no route change.
 *
 * The confirm route reads the Application's live Match and queues it exactly as
 * `queue()` does, so it reuses `SubmissionRepository` (never a second copy of the
 * queue rules).
 */
@Module({
  imports: [CareerProfileModule, SubmissionModule],
  controllers: [AddedFactsController],
  providers: [AddedFactsRepository, AddedFactsService],
  exports: [AddedFactsService, AddedFactsRepository],
})
export class AddedFactsModule {}
