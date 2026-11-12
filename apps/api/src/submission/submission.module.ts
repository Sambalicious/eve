import { type DynamicModule, Module } from "@nestjs/common"

import { AiModule } from "../ai/ai.module.js"
import type { BrowserConfig } from "../worker/worker.config.js"
import { BrowserMutex } from "./browser-mutex.js"
import { createPlaywrightFormSessions } from "./browser/create-form-sessions.js"
import { FormAgentRunner } from "./form-agent/form-agent-runner.js"
import { createBoardHttp } from "../discovery/sources/board-http.js"
import { FORM_SESSION_FACTORY, unavailableFormSessions } from "./form-session.js"
import { QUESTION_SCHEMAS, type QuestionSchemaSource, createGreenhouseQuestionSchemas } from "./question-schema.js"
import { SampleController } from "./sample.controller.js"
import { SampleRepository } from "./sample.repository.js"
import { SampleService } from "./sample.service.js"
import { SampleSubmissionQueue } from "./sample-submission-queue.js"
import { SampleSubmissionRunner } from "./sample-submission-runner.js"
import { SubmissionController } from "./submission.controller.js"
import { SubmissionRepository } from "./submission.repository.js"
import { SubmissionService } from "./submission.service.js"
import { CandidateIdentityRepository } from "../auth/candidate-identity.repository.js"
import { SubmissionStateService } from "./submission-state.service.js"

/**
 * Slice 5: submission, daily cap, duplicates, Activation Gate. The api process
 * has no browser (`unavailableFormSessions`); the worker's Playwright MCP
 * adapter replaces FORM_SESSION_FACTORY (ADR 0008). An approved sample is
 * handed to the worker through `SampleSubmissionQueue` (F-QA5-01).
 */
@Module({
  imports: [AiModule],
  controllers: [SubmissionController, SampleController],
  providers: [
    SubmissionRepository,
    BrowserMutex,
    SubmissionService,
    FormAgentRunner,
    SubmissionStateService,
    CandidateIdentityRepository,
    SampleRepository,
    SampleService,
    SampleSubmissionQueue,
    { provide: FORM_SESSION_FACTORY, useValue: unavailableFormSessions },
    { provide: QUESTION_SCHEMAS, useFactory: () => createGreenhouseQuestionSchemas(createBoardHttp()) },
  ],
  exports: [SubmissionService],
})
export class SubmissionModule {}

/**
 * The worker's view: the submission service only. FORM_SESSION_FACTORY is
 * `unavailableFormSessions` unless the worker config enables the Playwright MCP
 * browser (SUBMISSION_BROWSER_ENABLED=1, ADR 0008), so by default the worker can
 * run the job but cannot open a browser.
 */
@Module({})
export class SubmissionWorkerModule {
  /** `questionSchemas` replaces the Greenhouse schema reader (compose fixture checks only). */
  static forRoot(browser: BrowserConfig | null, options: Readonly<{ questionSchemas?: QuestionSchemaSource }> = {}): DynamicModule {
    return {
      module: SubmissionWorkerModule,
      imports: [AiModule],
      providers: [
        SubmissionRepository,
        BrowserMutex,
        SubmissionService,
        FormAgentRunner,
        SampleRepository,
        SampleService,
        SampleSubmissionRunner,
        { provide: FORM_SESSION_FACTORY, useFactory: () => (browser ? createPlaywrightFormSessions(browser) : unavailableFormSessions) },
        { provide: QUESTION_SCHEMAS, useFactory: () => options.questionSchemas ?? createGreenhouseQuestionSchemas(createBoardHttp()) },
      ],
      exports: [SubmissionService, SampleService, SampleSubmissionRunner, SubmissionRepository],
    }
  }
}
