import { Logger, Module } from "@nestjs/common"

import { ALERT_FEED_HTTP } from "./alert-feed-http.provider.js"
import { alertFeedTestOriginFromEnv, createAlertFeedHttp } from "./alert-feed-http.js"
import { HiringPostsController } from "./hiring-posts.controller.js"
import { HiringPostsReader } from "./hiring-posts-reader.js"
import { HiringPostsRepository } from "./hiring-posts.repository.js"
import { HiringPostsService } from "./hiring-posts.service.js"
import { StackPostsReader } from "./stack-posts-reader.js"
import { StackPostsSummaryReader } from "./stack-posts-summary.js"
import { StackPostsController } from "./stack-posts.controller.js"
import { StackPostsRepository } from "./stack-posts.repository.js"
import { StackPostsService } from "./stack-posts.service.js"

/**
 * The Alert feed client. `ALERT_FEED_TEST_ORIGIN` (browser QA only) replaces
 * the origin after the allowlist check. SEC-E5-04: it needs
 * `ALERT_FEED_TEST_ORIGIN_ENABLED=1`, must be `http://127.0.0.1:<port>` or
 * `http://localhost:<port>`, and is refused when NODE_ENV is production; any
 * violation stops the process at module init. A warning names the variable
 * (never its value) while it is active.
 */
const alertFeedHttpProvider = {
  provide: ALERT_FEED_HTTP,
  useFactory: () => {
    const testOrigin = alertFeedTestOriginFromEnv(process.env)
    if (testOrigin !== undefined) new Logger("AlertFeedHttp").warn("ALERT_FEED_TEST_ORIGIN is active: Alert feeds are read from a loopback test server, not Google")
    return createAlertFeedHttp({ ...(testOrigin ? { testOrigin } : {}), production: process.env["NODE_ENV"] === "production" })
  },
}

/** EPIC-0005, api process: the Stack posts routes. EPIC-0007 Phase 3: the Hiring routes. */
@Module({
  controllers: [StackPostsController, HiringPostsController],
  providers: [StackPostsRepository, StackPostsService, HiringPostsRepository, HiringPostsService, alertFeedHttpProvider],
})
export class StackPostsModule {}

/** EPIC-0005, worker process: scheduled feed reads and the daily summary section. EPIC-0007 Phase 3: the per-Candidate Hiring reader. */
@Module({
  providers: [StackPostsRepository, StackPostsReader, StackPostsSummaryReader, HiringPostsRepository, HiringPostsReader, alertFeedHttpProvider],
  exports: [StackPostsReader, StackPostsSummaryReader, HiringPostsReader],
})
export class StackPostsWorkerModule {}
