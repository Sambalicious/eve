import "reflect-metadata"

import { NestFactory } from "@nestjs/core"
import type { NestFastifyApplication } from "@nestjs/platform-fastify"

import { AppModule } from "./app.module.js"
import { parseConfig } from "./config/env.js"
import { assertStorageMigrated } from "./files/candidate-files.js"
import { configureHttpApp, createFastifyAdapter } from "./http/create-http-app.js"

const config = parseConfig(process.env)
// EPIC-0002 A2: refuse to start until storage:migrate has moved the files into the per-Candidate layout.
await assertStorageMigrated(config.candidateStorageDir)
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.forRoot(config),
  createFastifyAdapter(config)
)
await configureHttpApp(app, config)
await app.listen({ host: config.host, port: config.port })
