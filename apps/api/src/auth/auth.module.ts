import { Module } from "@nestjs/common"
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core"

import { AuthController } from "./auth.controller.js"
import { AuthGuard } from "./auth.guard.js"
import { CandidateIdentityRepository } from "./candidate-identity.repository.js"
import { CandidateScopeInterceptor } from "./candidate-scope.interceptor.js"
import { ConvertedFeatureGuard } from "./converted-feature.guard.js"
import { OperatorOnlyGuard } from "./operator-only.guard.js"
import { GoogleOidcClient } from "./google-oidc.client.js"
import { SessionController } from "./session.controller.js"
import { SessionRepository } from "./session.repository.js"
import { SessionService } from "./session.service.js"
import { SignInAttemptRepository } from "./sign-in-attempt.repository.js"
import { SignInService } from "./sign-in.service.js"
import { MeController } from "../me/me.controller.js"
import { MeService } from "../me/me.service.js"

@Module({
  controllers: [AuthController, SessionController, MeController],
  providers: [
    GoogleOidcClient,
    CandidateIdentityRepository,
    SessionRepository,
    SignInAttemptRepository,
    SessionService,
    MeService,
    SignInService,
    // Registration order is run order: the session first, then the conversion check.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OperatorOnlyGuard },
    { provide: APP_GUARD, useClass: ConvertedFeatureGuard },
    { provide: APP_INTERCEPTOR, useClass: CandidateScopeInterceptor },
  ],
})
export class AuthModule {}
