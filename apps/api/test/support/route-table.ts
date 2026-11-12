import type { INestApplication } from "@nestjs/common"
import { RequestMethod } from "@nestjs/common"
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js"
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core"

import { CONVERTED_FEATURE } from "../../src/auth/converted-feature.guard.js"
import { OPERATOR_ONLY } from "../../src/auth/operator-only.guard.js"
import { IS_PUBLIC, IS_PUBLIC_WRITE } from "../../src/auth/public.decorator.js"

export type MappedRoute = Readonly<{ route: string; isPublic: boolean; feature: string | undefined; operatorOnly: boolean }>

const METHODS: Readonly<Partial<Record<RequestMethod, string>>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
}

/**
 * Every route Nest maps, as "METHOD /path" with `:param` segments, read from the
 * real api app's controller metadata at boot, with the decorators the 404
 * registry checks (EPIC-0002 A2).
 */
export function routeTable(app: INestApplication): MappedRoute[] {
  const discovery = new DiscoveryService(app.get(ModulesContainer))
  const reflector = app.get(Reflector)
  const scanner = new MetadataScanner()
  const routes: MappedRoute[] = []
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined
    if (!instance || !wrapper.metatype) continue
    const base = String(Reflect.getMetadata(PATH_METADATA, wrapper.metatype) ?? "")
    const prototype = Object.getPrototypeOf(instance) as object
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name] as object
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined
      if (path === undefined || method === undefined) continue
      const full = `/${[base, path].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`
      const targets = [handler as never, wrapper.metatype as never]
      routes.push({
        route: `${METHODS[method] ?? String(method)} ${full}`,
        isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true || reflector.getAllAndOverride<boolean>(IS_PUBLIC_WRITE, targets) === true,
        feature: reflector.getAllAndOverride<string | undefined>(CONVERTED_FEATURE, targets),
        operatorOnly: reflector.getAllAndOverride<boolean>(OPERATOR_ONLY, targets) === true,
      })
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route))
}
