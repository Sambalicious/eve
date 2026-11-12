import { type DynamicModule, Global, Module } from "@nestjs/common"

import type { AppConfig, SharedRuntimeConfig } from "./env.js"

export const APP_CONFIG = Symbol("APP_CONFIG")

@Global()
@Module({})
export class ConfigModule {
  /** The api passes the full AppConfig; the worker passes only the shared part. */
  static forRoot(config: AppConfig | SharedRuntimeConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    }
  }
}
