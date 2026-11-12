import { Module } from "@nestjs/common"

import { APP_CONFIG } from "../config/config.module.js"
import { SPEND_CONFIG, spendConfigOf } from "./spend-config.js"
import { SpendLedger } from "./spend-ledger.js"

/** The spend ledger, shared by ModelGateway, the submission claim and the cost API. */
@Module({
  providers: [{ provide: SPEND_CONFIG, inject: [APP_CONFIG], useFactory: spendConfigOf }, SpendLedger],
  exports: [SpendLedger, SPEND_CONFIG],
})
export class SpendModule {}
