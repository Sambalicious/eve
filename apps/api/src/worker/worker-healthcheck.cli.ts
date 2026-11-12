import { isHeartbeatFresh } from "../shared/heartbeat.js"
import { WORKER_HEARTBEAT_FILE, WORKER_HEARTBEAT_MAX_AGE_MS } from "./worker-heartbeat.js"

/** Compose healthcheck for the worker: exit 0 when its heartbeat is recent. */
process.exitCode = (await isHeartbeatFresh(WORKER_HEARTBEAT_FILE, WORKER_HEARTBEAT_MAX_AGE_MS)) ? 0 : 1
