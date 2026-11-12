import { STACK_POST_SNIPPET_MAX, STACK_POST_TITLE_MAX } from "@eve/contracts"

import { decodeEntities } from "../discovery/sources/discovered-posting.js"
import { type TechnologyIndex, buildTechnologyIndex, namesAppearingInText } from "../discovery/technology-extraction.js"
import type { RawEntry } from "./alert-feed-parser.js"
import { type StackPostTarget, stackPostTarget } from "./stack-post-target.js"

/** Pure: raw feed entries to the rows Eve stores (AC 5.1-5.7). No I/O, no AI. */
export type CandidateStackPost = StackPostTarget &
  Readonly<{
    title: string
    snippet: string
    publishedAt: Date | null
    matchedTechnologies: readonly string[]
  }>

export type MatchCriteria = Readonly<{ frameworks: readonly string[]; technologies: readonly string[] }>

const EARLIEST_DATE = Date.UTC(2000, 0, 1)
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const SCRIPT_OR_STYLE_NAME = /script|style/iy
const BLOCK_TAG_NAME = /(?:br|p|div|li|ul|ol|h\d|tr|td|table|blockquote)\b/iy
const WHITESPACE = /\s/u

/**
 * Feed HTML to text. Unlike `htmlToText`, inline tags (`<b>`, `<i>`) are
 * removed without adding a space, so "<b>React</b>," stays "React,"; block
 * tags become a space. Entities are decoded after the tags are gone, so an
 * escaped `&lt;script&gt;` stays visible text.
 *
 * SEC-E5-01: the three passes give exactly the output of the earlier regexes
 *   1. `/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi` -> " "
 *   2. `/<\s*\/?\s*(br|p|div|li|ul|ol|h\d|tr|td|table|blockquote)\b[^>]*>/gi` -> " "
 *   3. `/<[^>]*>/g` -> ""
 * but each is one forward scan, linear in the input. Those regexes rescanned
 * to the end of the text from every `<` that had no match (seconds on 100k
 * characters). A tag runs from `<` to the next `>`, as `[^>]*>` matched.
 */
function feedHtmlToText(html: string): string {
  return decodeEntities(stripAllTags(stripBlockTags(stripScriptAndStyle(html))))
}

type TagMatch = { readonly end: number; readonly replacement: string } | null

/** Replaces leftmost, non-overlapping matches that start at a `<`, scanning forward once. */
function replaceTags(html: string, matchAt: (lt: number, gt: number) => TagMatch): string {
  const parts: string[] = []
  let copied = 0
  let from = 0
  let gt = -1
  for (let lt = html.indexOf("<", from); lt !== -1; lt = html.indexOf("<", from)) {
    if (gt <= lt) gt = html.indexOf(">", lt + 1)
    if (gt === -1) break // no `>` after this `<`, so none after any later one either
    const match = matchAt(lt, gt)
    if (match === null) {
      from = lt + 1
      continue
    }
    parts.push(html.slice(copied, lt), match.replacement)
    copied = from = match.end
  }
  parts.push(html.slice(copied))
  return parts.join("")
}

/** Index of the first non-whitespace character at or after `index`. Each run is skipped by the one `<` before it. */
function skipWhitespace(html: string, index: number): number {
  let i = index
  while (i < html.length && WHITESPACE.test(html[i]!)) i += 1
  return i
}

/** The sticky `pattern` matched at `index`, or undefined. */
function nameAt(html: string, index: number, pattern: RegExp): string | undefined {
  pattern.lastIndex = index
  return pattern.exec(html)?.[0]
}

function stripScriptAndStyle(html: string): string {
  const closes = { script: closingTagPositions(html, "script"), style: closingTagPositions(html, "style") }
  return replaceTags(html, (lt, gt) => {
    const name = nameAt(html, skipWhitespace(html, lt + 1), SCRIPT_OR_STYLE_NAME)?.toLowerCase() as "script" | "style" | undefined
    if (name === undefined) return null
    const close = closes[name].firstAfter(gt + 1)
    return close === null ? null : { end: close, replacement: " " }
  })
}

function stripBlockTags(html: string): string {
  return replaceTags(html, (lt, gt) => {
    let i = skipWhitespace(html, lt + 1)
    if (html[i] === "/") i = skipWhitespace(html, i + 1)
    return nameAt(html, i, BLOCK_TAG_NAME) === undefined ? null : { end: gt + 1, replacement: " " }
  })
}

function stripAllTags(html: string): string {
  return replaceTags(html, (_lt, gt) => ({ end: gt + 1, replacement: "" }))
}

/**
 * Every `</name>` (spaces allowed) found in one scan. `firstAfter(i)` gives the
 * end of the first one starting at or after `i`; queries only move forward, so
 * the cursor makes the whole pass linear.
 */
function closingTagPositions(html: string, name: "script" | "style"): { firstAfter(index: number): number | null } {
  const found = [...html.matchAll(new RegExp(`<\\s*\\/\\s*${name}\\s*>`, "gi"))].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  let cursor = 0
  return {
    firstAfter(index) {
      while (cursor < found.length && found[cursor]!.start < index) cursor += 1
      return cursor < found.length ? found[cursor]!.end : null
    },
  }
}

/**
 * SEC-E5-03: C0 controls except tab, newline and carriage return, plus DEL.
 * `&#0;` decodes to U+0000, which Postgres `text` rejects, so one such entry
 * would fail a registration (500) or every scheduled read of its feed.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu

/** AC 5.5: plain text, control characters removed, whitespace collapsed, capped in code points after cleaning. */
export function plainText(raw: string, isHtml: boolean, max: number): string {
  const decoded = isHtml ? feedHtmlToText(raw) : decodeEntities(raw)
  const text = decoded.replace(CONTROL_CHARACTERS, "").replace(/\s+/gu, " ").trim()
  const codePoints = Array.from(text)
  return codePoints.length > max ? codePoints.slice(0, max).join("") : text
}

/** AC 5.7: a finite date from 2000-01-01 to one day after `now`, else null. */
export function feedDate(value: string | null, now: Date): Date | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time < EARLIEST_DATE || time > now.getTime() + ONE_DAY_MS) return null
  return new Date(time)
}

/**
 * AC 5.6: Job criteria entries, Frameworks then Technologies, found as whole
 * tokens through the EPIC-0004 alias table, in the entered form, each once.
 * `toStackPosts` builds the index once for all entries (CR-E5-02).
 */
export function matchTechnologies(criteria: MatchCriteria | TechnologyIndex, title: string, snippet: string): string[] {
  const index = "entries" in criteria ? criteria : criteriaIndex(criteria)
  return namesAppearingInText(index, title, snippet)
}

function criteriaIndex(criteria: MatchCriteria): TechnologyIndex {
  return buildTechnologyIndex([...criteria.frameworks, ...criteria.technologies])
}

/** Keeps LinkedIn posts and articles only; the first entry wins for a repeated canonical URL (AC 5.3). */
export function toStackPosts(entries: readonly RawEntry[], criteria: MatchCriteria, now: Date): CandidateStackPost[] {
  const posts: CandidateStackPost[] = []
  const seen = new Set<string>()
  const index = criteriaIndex(criteria)
  for (const entry of entries) {
    const target = stackPostTarget(entry.link)
    if (!target || seen.has(target.canonicalUrl)) continue
    seen.add(target.canonicalUrl)
    const title = plainText(entry.title, entry.titleIsHtml, STACK_POST_TITLE_MAX)
    const snippet = plainText(entry.snippet, entry.snippetIsHtml, STACK_POST_SNIPPET_MAX)
    posts.push({
      ...target,
      title,
      snippet,
      publishedAt: feedDate(entry.published, now) ?? feedDate(entry.updated, now),
      matchedTechnologies: matchTechnologies(index, title, snippet),
    })
  }
  return posts
}
