import { type DynamicModule, Module } from "@nestjs/common"
import { APP_FILTER } from "@nestjs/core"

import { AccessRequestModule } from "./access-request/access-request.module.js"
import { AiModule } from "./ai/ai.module.js"
import { AnswersModule } from "./answers/answers.module.js"
import { AuthModule } from "./auth/auth.module.js"
import { CareerProfileModule } from "./career-profile/career-profile.module.js"
import { ConfigModule } from "./config/config.module.js"
import type { AppConfig } from "./config/env.js"
import { DatabaseModule } from "./db/database.module.js"
import { DiscoveryModule } from "./discovery/discovery.module.js"
import { DocumentsModule } from "./documents/documents.module.js"
import { FilesModule } from "./files/files.module.js"
import { HealthModule } from "./health/health.module.js"
import { JobCriteriaModule } from "./job-criteria/job-criteria.module.js"
import { LeadsModule } from "./leads/leads.module.js"
import { PreferencesModule } from "./preferences/preferences.module.js"
import { NotificationModule } from "./notification/notification.module.js"
import { OutreachModule } from "./outreach/outreach.module.js"
import { ApiExceptionFilter } from "./http/api-exception.filter.js"
import { ClockModule } from "./shared/clock.js"
import { RecordsModule } from "./records/records.module.js"
import { StackPostsModule } from "./stack-posts/stack-posts.module.js"
import { ControlsModule } from "./spend/controls.module.js"
import { SubmissionModule } from "./submission/submission.module.js"

/** The `api` process: authenticated REST under /v1. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ClockModule,
        DatabaseModule,
        FilesModule,
        HealthModule,
        AuthModule,
        AiModule,
        AnswersModule,
        CareerProfileModule,
        DiscoveryModule,
        JobCriteriaModule,
        LeadsModule,
        PreferencesModule,
        DocumentsModule,
        OutreachModule,
        SubmissionModule,
        NotificationModule,
        AccessRequestModule,
        ControlsModule,
        RecordsModule,
        StackPostsModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    }
  }
}
