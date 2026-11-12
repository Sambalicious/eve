import { Global, Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common"

import { APP_CONFIG } from "../config/config.module.js"
import { CandidateFiles, assertStorageMigrated } from "./candidate-files.js"

/**
 * EPIC-0002 A2 (architecture r4 Files): "Boot refuses until storage:migrate has
 * completed." Runs in onModuleInit, before any bootstrap hook touches a file.
 */
/** The part of the api and worker config FilesModule reads. */
export type FilesConfig = Readonly<{ candidateStorageDir: string }>

@Injectable()
class StorageBootCheck implements OnModuleInit {
  constructor(@Inject(APP_CONFIG) private readonly config: FilesConfig) {}

  async onModuleInit(): Promise<void> {
    await assertStorageMigrated(this.config.candidateStorageDir)
  }
}

/** The api and the worker share one CandidateFiles over the per-Candidate root. */
@Global()
@Module({
  providers: [
    { provide: CandidateFiles, inject: [APP_CONFIG], useFactory: (config: FilesConfig) => new CandidateFiles(config.candidateStorageDir) },
    StorageBootCheck,
  ],
  exports: [CandidateFiles],
})
export class FilesModule {}
