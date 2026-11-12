import { Controller, Get, Header } from "@nestjs/common"
import type { NotificationStatus } from "@eve/contracts"

import { NotificationStatusService } from "./notification-status.service.js"
import { ConvertedFeature } from "../auth/converted-feature.guard.js"

/** Guarded by the global session guard (single Candidate: being signed in is ownership). */
@Controller("v1")
export class NotificationController {
  constructor(private readonly service: NotificationStatusService) {}

  @ConvertedFeature("notifications")
  @Get("notifications/status")
  @Header("cache-control", "no-store")
  status(): Promise<NotificationStatus> {
    return this.service.status()
  }
}
