import { Module } from "@nestjs/common"

import { JobCriteriaSaveLimitGuard, JobCriteriaSaveLimiter } from "./job-criteria-save-limit.guard.js"
import { JobCriteriaController } from "./job-criteria.controller.js"
import { JobCriteriaRepository } from "./job-criteria.repository.js"
import { JobCriteriaService } from "./job-criteria.service.js"

/** EPIC-0004: the Candidate's Job criteria and the save-time re-decision. api process only. */
@Module({
  controllers: [JobCriteriaController],
  providers: [JobCriteriaRepository, JobCriteriaService, JobCriteriaSaveLimiter, JobCriteriaSaveLimitGuard],
})
export class JobCriteriaModule {}
