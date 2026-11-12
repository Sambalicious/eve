import { Body, Controller, Get, Header, HttpCode, Param, Post, Put } from "@nestjs/common"
import { type OutreachItem, type OutreachResponse, readerNameRequestSchema } from "@eve/contracts"

import { CandidateScope } from "../db/candidate-scope.js"
import { parseRequest } from "../http/parse-body.js"
import { outreachKind, outreachUuid } from "./outreach-path.js"
import { OutreachService } from "./outreach.service.js"

/**
 * v1.31.0 EPIC-0014 Outreach messages (api-contract.md section 4, architecture r1
 * D4). Three private dashboard routes on one Application:
 *
 * - `GET  …/outreach`                 read the three items and `approvedProfileVersion` (no CSRF).
 * - `POST …/outreach/:kind/write`     202 with the item `running`; no body; the Run continues in the api process.
 * - `PUT  …/outreach/:kind/reader-name` save or clear the Reader name; 200 with the recomposed item.
 *
 * The global guard requires the Candidate's session on all three and the CSRF
 * header on POST and PUT; there is no feature guard, so `feature_not_yet_available`
 * is never returned. `:kind` is the kebab path slug and the JSON value is snake
 * case, so an unknown slug (including the snake form in a path) is `404`.
 *
 * A malformed id, an unknown kind, a missing or another Candidate's Application
 * and an Application whose details are deleted are all the same `404 not_found`
 * (section 2, "The 404 rule"). CR-6: the two state-changing routes resolve that
 * path and 404 in a pre-body Fastify hook (`outreach-path-gate.ts`), so a body
 * error cannot answer first. No Outreach route answers 409. A request that
 * arrives while the details are being deleted waits on the Application row lock
 * and then answers normally, or 404 once the deletion has committed.
 */
@Controller("v1/applications")
export class OutreachController {
  constructor(private readonly service: OutreachService) {}

  @Get(":id/outreach")
  @Header("cache-control", "no-store")
  read(@Param("id") id: string): Promise<OutreachResponse> {
    // The explicit scope is the session's Candidate; the service opens one transaction per read.
    return this.service.read(CandidateScope.require(), outreachUuid(id))
  }

  /** 202: the Run runs in the background. A second request while one is in flight returns the same item and starts nothing. */
  @Post(":id/outreach/:kind/write")
  @HttpCode(202)
  @Header("cache-control", "no-store")
  write(@Param("id") id: string, @Param("kind") kind: string): Promise<OutreachItem> {
    return this.service.startWrite(outreachUuid(id), outreachKind(kind))
  }

  @Put(":id/outreach/:kind/reader-name")
  @Header("cache-control", "no-store")
  setReaderName(@Param("id") id: string, @Param("kind") kind: string, @Body() body: unknown): Promise<OutreachItem> {
    // The path is read before the body (section 2, step 3 before step 4), so a malformed id or an unknown
    // kind answers `404 not_found` even when the body is malformed too, rather than relying on the body's 400.
    // CR-6: Fastify parses the body before this handler, so the pre-body gate resolves the same path (and the
    // Application 404) first; this order still holds for anything the gate lets through.
    const applicationId = outreachUuid(id)
    const parsedKind = outreachKind(kind)
    // A malformed body, a non-object, a missing key, an unknown extra key or a non-string is `400 bad_request`.
    const request = parseRequest(readerNameRequestSchema, body)
    return this.service.setReaderName(applicationId, parsedKind, request.readerName)
  }
}
