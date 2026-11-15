import { Module } from "@nestjs/common"

import { ExtensionController } from "./extension.controller.js"
import { ExtensionService } from "./extension.service.js"
import { SubmissionModule } from "../submission/submission.module.js"

/**
 * ADR 0016 slice 1: the endpoint the side-loaded browser extension calls to
 * fill a form in the Candidate's own tab. It imports the submission module for
 * its answer sources and adds no write path of its own.
 */
@Module({
  imports: [SubmissionModule],
  controllers: [ExtensionController],
  providers: [ExtensionService],
})
export class ExtensionModule {}
