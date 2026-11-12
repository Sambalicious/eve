import { SaxesParser, type SaxesTagNS } from "saxes"

/**
 * Pure parser for a Google Alerts feed (architecture "Feed parser"). Atom
 * first, RSS 2.0 accepted. Strict XML with namespaces; a DOCTYPE, a parse
 * error or a root that is not Atom `feed` or `rss` with a `channel` is
 * `NotAFeedError`. Entities are never resolved (saxes is non-validating and a
 * DOCTYPE is refused), so no external entity can be expanded.
 */
export const ATOM_NS = "http://www.w3.org/2005/Atom"
/** Defence against a hostile but small feed. */
export const MAX_ENTRIES = 100
/**
 * SEC-E5-01: Atom and RSS need at most 4 levels (5 with xhtml content); a
 * deeper document is refused as not a feed before saxes' per-level cost adds up.
 */
export const MAX_DEPTH = 16
/** SEC-E5-01: raw text kept per field. Far above the stored caps (300 and 1,000 after cleaning). */
export const FIELD_TEXT_MAX = 16 * 1024

export class NotAFeedError extends Error {
  constructor() {
    super("not_a_feed")
    this.name = "NotAFeedError"
  }
}

export type RawEntry = Readonly<{
  title: string
  /** Atom `type="html"` or RSS: the text is HTML to strip. */
  titleIsHtml: boolean
  link: string | null
  published: string | null
  updated: string | null
  snippet: string
  snippetIsHtml: boolean
}>

type Field = "title" | "link" | "published" | "updated" | "content" | "summary" | "description" | "pubDate"

type EntryDraft = {
  title: string
  titleIsHtml: boolean
  link: string | null
  published: string | null
  updated: string | null
  content: string | null
  contentIsHtml: boolean
  summary: string | null
  summaryIsHtml: boolean
}

const ATOM_FIELDS = new Set<string>(["title", "published", "updated", "content", "summary"])
const RSS_FIELDS = new Set<string>(["title", "link", "description", "pubDate"])

function draft(): EntryDraft {
  return { title: "", titleIsHtml: false, link: null, published: null, updated: null, content: null, contentIsHtml: false, summary: null, summaryIsHtml: false }
}

function isHtmlType(tag: SaxesTagNS): boolean {
  const type = tag.attributes["type"]?.value
  return type === "html" || type === "xhtml"
}

export function parseAlertFeed(xml: string): RawEntry[] {
  if (xml.trim() === "") throw new NotAFeedError()
  const parser = new SaxesParser({ xmlns: true, position: false })
  let format: "atom" | "rss" | null = null
  let depth = 0
  let sawChannel = false
  let entry: EntryDraft | null = null
  let entryDepth = -1
  let field: Field | null = null
  let fieldDepth = -1
  let text = ""
  const entries: RawEntry[] = []
  let failed = false

  parser.on("error", () => {
    failed = true
    throw new NotAFeedError()
  })
  parser.on("doctype", () => {
    failed = true
    throw new NotAFeedError()
  })
  parser.on("opentag", (tag) => {
    depth += 1
    if (depth > MAX_DEPTH) throw new NotAFeedError()
    if (depth === 1) {
      if (tag.local === "feed" && tag.uri === ATOM_NS) format = "atom"
      else if (tag.name === "rss" && tag.uri === "") format = "rss"
      else throw new NotAFeedError()
      return
    }
    if (format === "rss" && depth === 2 && tag.name === "channel") sawChannel = true
    const isEntryTag = format === "atom" ? tag.local === "entry" && tag.uri === ATOM_NS && depth === 2 : tag.name === "item" && depth === 3 && sawChannel
    if (isEntryTag) {
      entry = draft()
      entryDepth = depth
      return
    }
    if (!entry || depth !== entryDepth + 1 || field) return
    if (format === "atom" && tag.uri === ATOM_NS) {
      if (tag.local === "link") {
        const rel = tag.attributes["rel"]?.value
        const href = tag.attributes["href"]?.value
        if (entry.link === null && href !== undefined && (rel === undefined || rel === "alternate")) entry.link = href
        return
      }
      if (ATOM_FIELDS.has(tag.local)) {
        field = tag.local as Field
        fieldDepth = depth
        text = ""
        if (field === "title") entry.titleIsHtml = isHtmlType(tag)
        if (field === "content") entry.contentIsHtml = isHtmlType(tag)
        if (field === "summary") entry.summaryIsHtml = isHtmlType(tag)
      }
    } else if (format === "rss" && tag.uri === "" && RSS_FIELDS.has(tag.name)) {
      field = tag.name as Field
      fieldDepth = depth
      text = ""
    }
  })
  const onText = (value: string) => {
    if (field && text.length < FIELD_TEXT_MAX) text += value.slice(0, FIELD_TEXT_MAX - text.length)
  }
  parser.on("text", onText)
  parser.on("cdata", onText)
  parser.on("closetag", () => {
    if (field && depth === fieldDepth && entry) {
      assign(entry, field, text, format === "rss")
      field = null
      fieldDepth = -1
    } else if (entry && depth === entryDepth) {
      if (entries.length < MAX_ENTRIES) entries.push(finish(entry, format === "rss"))
      entry = null
      entryDepth = -1
    }
    depth -= 1
  })

  try {
    parser.write(xml).close()
  } catch {
    throw new NotAFeedError()
  }
  if (failed || format === null || (format === "rss" && !sawChannel)) throw new NotAFeedError()
  return entries
}

function assign(entry: EntryDraft, field: Field, value: string, rss: boolean): void {
  switch (field) {
    case "title":
      entry.title = value
      if (rss) entry.titleIsHtml = true
      return
    case "link":
      entry.link = value.trim() || null
      return
    case "published":
    case "pubDate":
      entry.published = value.trim() || null
      return
    case "updated":
      entry.updated = value.trim() || null
      return
    case "content":
      entry.content = value
      return
    case "summary":
    case "description":
      entry.summary = value
      entry.summaryIsHtml = rss || entry.summaryIsHtml
      return
  }
}

function finish(entry: EntryDraft, rss: boolean): RawEntry {
  const useContent = entry.content !== null
  return {
    title: entry.title,
    titleIsHtml: entry.titleIsHtml || rss,
    link: entry.link,
    published: entry.published,
    updated: entry.updated,
    snippet: (useContent ? entry.content : entry.summary) ?? "",
    snippetIsHtml: useContent ? entry.contentIsHtml : entry.summaryIsHtml,
  }
}
