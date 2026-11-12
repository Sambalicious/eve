import { Module } from "@nestjs/common"

import { ControlsController } from "./controls.controller.js"
import { ControlsService } from "./controls.service.js"
import { SpendModule } from "./spend.module.js"

/** The api's pause, spend and ceiling endpoints. */
@Module({
  imports: [SpendModule],
  controllers: [ControlsController],
  providers: [ControlsService],
})
export class ControlsModule {}
