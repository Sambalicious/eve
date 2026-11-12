import { Module } from "@nestjs/common"

import { AiModule } from "../ai/ai.module.js"
import { CareerProfileController } from "./career-profile.controller.js"
import { CareerProfileRepository } from "./career-profile.repository.js"
import { CareerProfileService } from "./career-profile.service.js"
import { COMPILED_EXTRACTION_CHILD, EXTRACTION_CHILD } from "./resume-text.js"

/** Resume upload, drafting through ModelGateway, and Career Profile versions (AC 1.1). */
@Module({
  imports: [AiModule],
  controllers: [CareerProfileController],
  providers: [CareerProfileRepository, CareerProfileService, { provide: EXTRACTION_CHILD, useValue: COMPILED_EXTRACTION_CHILD }],
  exports: [CareerProfileService],
})
export class CareerProfileModule {}
