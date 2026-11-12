import { Module } from "@nestjs/common"

import { AiModule } from "../ai/ai.module.js"
import { ApplicationsController, AtsMinimumController, CandidateContactController, DocumentsListController } from "./documents.controller.js"
import { DocumentSweep } from "./document-sweep.js"
import { DocumentsRepository } from "./documents.repository.js"
import { DocumentsService } from "./documents.service.js"

/** Slice 4: Applications (prepared) and Tailored Documents (AC 5). Api only: the hourly DocumentSweep needs the read-write document volume (E4.4). */
@Module({
  imports: [AiModule],
  controllers: [ApplicationsController, DocumentsListController, CandidateContactController, AtsMinimumController],
  providers: [DocumentsRepository, DocumentsService, DocumentSweep],
  // EPIC-0014 architecture r1 finding 7: Outreach reads the Application, posting, approved profile and
  // contact row through these four read-only queries instead of copying them.
  exports: [DocumentsRepository],
})
export class DocumentsModule {}
