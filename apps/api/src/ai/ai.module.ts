import { Module } from "@nestjs/common"

import { SpendModule } from "../spend/spend.module.js"

import { AiCallRepository } from "./ai-call.repository.js"
import { AiProviderController } from "./ai-provider.controller.js"
import { AiProviderRepository } from "./ai-provider.repository.js"
import { AiProviderService } from "./ai-provider.service.js"
import { MastraModelClient } from "./mastra-model-client.js"
import { MODEL_CLIENT } from "./model-client.js"
import { ModelGateway } from "./model-gateway.js"

@Module({
  imports: [SpendModule],
  controllers: [AiProviderController],
  providers: [
    AiProviderRepository,
    AiCallRepository,
    AiProviderService,
    ModelGateway,
    { provide: MODEL_CLIENT, useClass: MastraModelClient },
  ],
  exports: [ModelGateway, AiProviderRepository, SpendModule],
})
export class AiModule {}
