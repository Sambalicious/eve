import "reflect-metadata"

import { NestFactory } from "@nestjs/core"

import { assertStorageMigrated } from "./files/candidate-files.js"
import { parseWorkerConfig } from "./worker/worker.config.js"
import { WorkerModule } from "./worker/worker.module.js"

const config = parseWorkerConfig(process.env)
// EPIC-0002 A2: refuse to start until storage:migrate has moved the files into the per-Candidate layout.
await assertStorageMigrated(config.candidateStorageDir)
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config))
app.enableShutdownHooks()
await app.init()
