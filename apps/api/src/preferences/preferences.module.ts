import { Module } from "@nestjs/common"

import { PreferencesSaveEffects } from "./preferences-save-effects.js"
import { PreferencesSaveLimitGuard, PreferencesSaveLimiter } from "./preferences-save-limit.guard.js"
import { PreferencesController } from "./preferences.controller.js"
import { PreferencesRepository } from "./preferences.repository.js"
import { PreferencesService } from "./preferences.service.js"

/** EPIC-0002 B1: the session Candidate's Job Preferences. api process only. */
@Module({
  controllers: [PreferencesController],
  providers: [PreferencesRepository, PreferencesService, PreferencesSaveEffects, PreferencesSaveLimiter, PreferencesSaveLimitGuard],
})
export class PreferencesModule {}
