import { Module } from "@nestjs/common"

import { AiModule } from "../ai/ai.module.js"
import { DocumentsModule } from "../documents/documents.module.js"
import { OutreachController } from "./outreach.controller.js"
import { OutreachRepository } from "./outreach.repository.js"
import { OutreachService } from "./outreach.service.js"

/**
 * v1.31.0 EPIC-0014 Outreach messages (architecture r1). Api process only: the
 * Run is a background task in this process, as document generation is, and the
 * worker only reaches the table through `deleteDetailsLocked`.
 *
 * `DocumentsModule` must export `DocumentsRepository` (architecture r1 findings,
 * item 7) for the four read-only queries the service makes (Application, posting,
 * approved profile, contact row); the gateway comes from `AiModule`.
 */
@Module({
  imports: [AiModule, DocumentsModule],
  controllers: [OutreachController],
  providers: [OutreachRepository, OutreachService],
})
export class OutreachModule {}
