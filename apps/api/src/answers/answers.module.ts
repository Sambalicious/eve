import { Module } from "@nestjs/common"

import { ApprovedAnswersController } from "./approved-answers.controller.js"
import { ApprovedAnswersRepository } from "./approved-answers.repository.js"
import { ApprovedAnswersService } from "./approved-answers.service.js"
import { CandidateSettingsController, SalaryController } from "./salary.controller.js"
import { SalaryRepository } from "./salary.repository.js"
import { SalaryService } from "./salary.service.js"

/** Approved Answers, salary answers and Candidate settings (AC 1.3 to 1.5). */
@Module({
  controllers: [ApprovedAnswersController, SalaryController, CandidateSettingsController],
  providers: [ApprovedAnswersRepository, ApprovedAnswersService, SalaryRepository, SalaryService],
  exports: [ApprovedAnswersService, SalaryService],
})
export class AnswersModule {}
