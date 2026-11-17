import "reflect-metadata"

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { ApiException } from "./api-exception.js"
import { parseRequest } from "./parse-body.js"
import { ZodBody, ZodQuery, ZodRequestPipe } from "./zod-request.js"

const schema = z.object({ enabled: z.boolean() }).strict()

async function refusal(run: () => Promise<unknown> | unknown): Promise<ApiException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ApiException) return error
    throw error
  }
  throw new Error("expected the call to throw")
}

describe("ZodRequestPipe", () => {
  it("returns the parsed value", async () => {
    expect(await new ZodRequestPipe(schema).transform({ enabled: true })).toEqual({ enabled: true })
  })

  it("applies schema defaults like parseRequest", async () => {
    const withDefault = z.object({ n: z.coerce.number().default(3) })
    expect(await new ZodRequestPipe(withDefault).transform({})).toEqual({ n: 3 })
  })

  it.each([undefined, null, [], "x", {}, { enabled: "yes" }, { enabled: true, extra: 1 }])("refuses %j with the same exception as parseRequest", async (value) => {
    const fromPipe = await refusal(() => new ZodRequestPipe(schema).transform(value))
    const fromParse = await refusal(() => parseRequest(schema, value))
    expect(fromPipe.code).toBe("bad_request")
    expect(fromPipe.getStatus()).toBe(400)
    expect(fromPipe.getResponse()).toEqual(fromParse.getResponse())
    expect(fromPipe.fieldErrors).toEqual(fromParse.fieldErrors)
  })

  it("registers the pipe on the handler parameter", () => {
    class Probe {
      body(): void {}
      query(): void {}
    }
    ZodBody(schema)(Probe.prototype, "body", 0)
    ZodQuery("view", schema)(Probe.prototype, "query", 0)
    const bodyArgs = Reflect.getMetadata("__routeArguments__", Probe, "body") as Record<string, { pipes: unknown[] }>
    expect(Object.values(bodyArgs)[0]?.pipes[0]).toBeInstanceOf(ZodRequestPipe)
    const queryArgs = Reflect.getMetadata("__routeArguments__", Probe, "query") as Record<string, { pipes: unknown[]; data: unknown }>
    expect(Object.values(queryArgs)[0]?.data).toBe("view")
    expect(Object.values(queryArgs)[0]?.pipes[0]).toBeInstanceOf(ZodRequestPipe)
  })
})

/**
 * Every handler input goes through a contract schema (`@ZodBody` / `@ZodQuery`), so an invalid
 * request answers the one `bad_request` envelope. A handler may take a raw `@Body()` or `@Query()`
 * only when it validates by a rule `parseRequest` cannot express; each is listed here with the reason.
 */
const SRC = fileURLToPath(new URL("../", import.meta.url))

const RAW_INPUT_ALLOWED: Record<string, string> = {
  "access-request/access-request.controller.ts#AccessRequestController.create": "the service maps a bad body to access_request_invalid field codes, on a public route",
  "auth/auth.controller.ts#AuthController.start": "`next` is an opaque redirect target the sign-in service sanitises; a bad one falls back, never a 400",
  "documents/documents.controller.ts#ApplicationsController.list": "an unknown or repeated `retention` value is ignored (full list), by design (D-E11)",
  "job-criteria/job-criteria.controller.ts#JobCriteriaController.update": "a 400 carries per-field errors built from the raw body",
  "preferences/preferences.controller.ts#PreferencesController.read": "this GET takes no query parameter; any one is refused",
  "preferences/preferences.controller.ts#PreferencesController.save": "bounds, shape and per-field errors come from parseSaveBody",
  "preferences/preferences.controller.ts#PreferencesController.versions": "the query is defaulted from an absent object before parsing",
  "stack-posts/hiring-posts.controller.ts#HiringPostsController.posts": "page parsing answers a bad_request carrying a page field error",
  "stack-posts/hiring-posts.controller.ts#HiringPostsController.register": "JSON content type is checked first and a 400 carries registration field errors",
  "stack-posts/hiring-posts.controller.ts#HiringPostsController.saveVerification": "JSON content type is checked first and a 400 carries every field error",
  "stack-posts/stack-posts.controller.ts#StackPostsController.posts": "page parsing answers a bad_request carrying a page field error",
  "stack-posts/stack-posts.controller.ts#StackPostsController.register": "JSON content type is checked first and a 400 carries registration field errors",
  "stack-posts/stack-posts.controller.ts#StackPostsController.saveVerification": "JSON content type is checked first and a 400 carries every field error",
  "outreach/outreach.controller.ts#OutreachController.setReaderName": "the kind (a slug, not a UUID) is checked before the body, and a body pipe would run first",
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === "db" ? [] : controllerFiles(path)
    return path.endsWith(".controller.ts") ? [path] : []
  })
}

/** `file#Class.method` for every handler parameter decorated with a bare `@Body` or `@Query`. */
function rawInputHandlers(): string[] {
  const found: string[] = []
  for (const path of controllerFiles(SRC)) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name) {
        for (const parameter of node.parameters) {
          for (const decorator of ts.getDecorators(parameter) ?? []) {
            const call = decorator.expression
            const name = ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : undefined
            if (name === "Body" || name === "Query") found.push(`${relative(SRC, path)}#${node.parent.name.text}.${node.name.getText(file)}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return [...new Set(found)].sort()
}

describe("controller handler input", () => {
  const raw = rawInputHandlers()

  it("takes no raw @Body() or @Query() outside the documented exceptions", () => {
    expect(raw.filter((handler) => !(handler in RAW_INPUT_ALLOWED))).toEqual([])
  })

  it("lists no exception that no longer exists", () => {
    expect(Object.keys(RAW_INPUT_ALLOWED).filter((handler) => !raw.includes(handler))).toEqual([])
  })
})
