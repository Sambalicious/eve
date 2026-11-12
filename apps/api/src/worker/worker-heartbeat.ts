import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"

import { Heartbeat } from "../shared/heartbeat.js"

/**
 * In a directory the image creates for the runtime user (node:node 0700), not the
 * shared /tmp (SEC-211). Written by the worker, read by `worker-healthcheck.cli.js`.
 */
export const WORKER_HEARTBEAT_DIR = "/app/run"
export const WORKER_HEARTBEAT_FILE = `${WORKER_HEARTBEAT_DIR}/worker-heartbeat`
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000
export const WORKER_HEARTBEAT_MAX_AGE_MS = 30_000

/** Starts the worker's heartbeat once pg-boss is up, so healthy means ready. */
@Injectable()
export class WorkerHeartbeat implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly heartbeat = new Heartbeat(WORKER_HEARTBEAT_FILE, WORKER_HEARTBEAT_INTERVAL_MS)

  onApplicationBootstrap(): void {
    this.heartbeat.start()
  }

  onApplicationShutdown(): void {
    this.heartbeat.stop()
  }
}
