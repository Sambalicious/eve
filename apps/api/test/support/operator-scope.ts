import type { INestApplicationContext } from "@nestjs/common"

import { TenantDatabase } from "../../src/db/tenant-database.js"

/**
 * EPIC-0002 A1: tests that call a service or repository directly (not through
 * a route) run it in the owner's (Operator's) scope, as the session or the
 * worker's Operator-only job does. Every method call on the returned object
 * runs inside `TenantDatabase.asOperator`.
 */
export function asOperator<T extends object>(context: INestApplicationContext, target: T): T {
  return asOperatorWith(context.get(TenantDatabase), target)
}

/** As `asOperator`, for a test that builds its own `TenantDatabase` (no Nest context). */
export function asOperatorWith<T extends object>(tenant: TenantDatabase, target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown
      if (typeof value !== "function") return value
      return (...args: unknown[]) => tenant.asOperator(async () => (value as (...a: unknown[]) => unknown).apply(object, args))
    },
  })
}
