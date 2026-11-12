import { Module } from "@nestjs/common"

import { AiModule } from "../ai/ai.module.js"
import { DiscoveryPipeline } from "./discovery-pipeline.js"
import { DiscoveryRepository } from "./discovery.repository.js"
import { JobPostingsController, JobSourcesController, EligibilitySettingsController } from "./discovery.controller.js"
import { DiscoveryService } from "./discovery.service.js"
import { EvaluationQueue } from "./evaluation-queue.js"
import { PostingEvaluator } from "./posting-evaluator.js"
import { createBoardHttp } from "./sources/board-http.js"
import { BOARD_HTTP } from "./sources/board-http.provider.js"

/** Slice 3: Job Sources, discovery, pasted links, Eligibility, Match and ranking (AC 1.7 to 1.10, 3, 4). */
@Module({
  imports: [AiModule],
  controllers: [JobSourcesController, JobPostingsController, EligibilitySettingsController],
  providers: [
    DiscoveryRepository,
    DiscoveryPipeline,
    PostingEvaluator,
    DiscoveryService,
    EvaluationQueue,
    { provide: BOARD_HTTP, useFactory: () => createBoardHttp() },
  ],
  exports: [DiscoveryPipeline, PostingEvaluator, DiscoveryRepository],
})
export class DiscoveryModule {}

/** The worker's view: no controllers, only the pipeline and evaluator. */
@Module({
  imports: [AiModule],
  providers: [DiscoveryRepository, DiscoveryPipeline, PostingEvaluator, { provide: BOARD_HTTP, useFactory: () => createBoardHttp() }],
  exports: [DiscoveryPipeline, PostingEvaluator, DiscoveryRepository],
})
export class DiscoveryWorkerModule {}
