import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { ApiException } from "./api-exception.js"
import { JsonBodyGuard } from "./json-body.guard.js"

const context = (contentType: string | undefined) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: contentType === undefined ? {} : { "content-type": contentType } }) }) }) as unknown as ExecutionContext

describe("JsonBodyGuard", () => {
  it.each(["application/json", "application/json; charset=utf-8", "application/json;charset=utf-8", "APPLICATION/JSON", "application/json ;x=1"])("lets %j through", (contentType) => {
    expect(new JsonBodyGuard().canActivate(context(contentType))).toBe(true)
  })

  it.each([undefined, "", "text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/json-patch+json", "multipart/form-data; boundary=application/json"])("refuses %j with a plain 400", (contentType) => {
    expect.assertions(2)
    try {
      new JsonBodyGuard().canActivate(context(contentType))
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException)
      expect((error as ApiException).code).toBe("bad_request")
    }
  })
})
