import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import type { AddedFactsView, Submission } from "@eve/contracts"
import { removeAddedFactQuerySchema } from "@eve/contracts"
import { z } from "zod"

import { ConvertedFeature } from "../auth/converted-feature.guard.js"
import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { AddedFactsService } from "./added-facts.service.js"

/**
 * FEAT-0017: the five routes under `/v1/applications/{id}/added-facts`. The
 * global guard checks the session and the CSRF token; the `onRequest` path gate
 * answers 404 before any body parser when the flag is off, the id is malformed
 * or the Application is not the session Candidate's. Every success body is the
 * resource itself and is uncacheable.
 */
@Controller("v1/applications")
export class AddedFactsController {
  constructor(private readonly service: AddedFactsService) {}

  @Get(":id/added-facts")
  @Header("cache-control", "no-store")
  read(@Param("id") id: string): Promise<AddedFactsView> {
    return this.service.read(uuid(id))
  }

  @Post(":id/added-facts")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  add(@Param("id") id: string, @Body() body: unknown) {
    return this.service.add(uuid(id), body)
  }

  @Patch(":id/added-facts/:factId")
  @Header("cache-control", "no-store")
  edit(@Param("id") id: string, @Param("factId") factId: string, @Body() body: unknown): Promise<AddedFactsView> {
    return this.service.edit(uuid(id), uuid(factId), body)
  }

  @Delete(":id/added-facts/:factId")
  @Header("cache-control", "no-store")
  remove(@Param("id") id: string, @Param("factId") factId: string, @Query("expectedVersion") expectedVersion: unknown): Promise<AddedFactsView> {
    const version = parseRequest(removeAddedFactQuerySchema, { expectedVersion })
    return this.service.remove(uuid(id), uuid(factId), version.expectedVersion)
  }

  @ConvertedFeature("submission")
  @Post(":id/added-facts/confirm")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  confirm(@Param("id") id: string, @Body() body: unknown): Promise<Submission> {
    return this.service.confirm(uuid(id), body)
  }
}

function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiException("not_found")
  return value
}
