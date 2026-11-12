import type { TestProject } from "vitest/node"

import { startCluster } from "./postgres-cluster.js"

declare module "vitest" {
  export interface ProvidedContext {
    postgresAdminUrl: string
    /** The cluster container, for tools that must match the server version (pg_dump 17 in backup-restore.int-spec.ts). */
    postgresContainerId: string
  }
}

/**
 * One Postgres container for the whole integration run. Starting one per test
 * file (about ten at once) timed out in Testcontainers' 30 s port-bind wait.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { container, adminUrl } = await startCluster()
  project.provide("postgresAdminUrl", adminUrl)
  project.provide("postgresContainerId", container.getId())
  return async () => {
    await container.stop()
  }
}
