/**
 * Run a2c invariant 2: the text check TenantDatabase runs on every compiled
 * statement before a scope sends it. A scope is one transaction from open to
 * commit, so its statements may not end, restart, split or re-authorise that
 * transaction, and each call is one statement.
 *
 * Repair wave 2 (F-SEC-13, F-SEC-14): the text must be a non-empty string,
 * and the one statement a data statement (or `SET LOCAL`) that leaves nothing
 * on the pooled session: no session setting, temporary object, prepared
 * statement, listener or session advisory lock.
 *
 * The scanner follows Postgres's lexical rules for what can hide a `;` or a
 * keyword: single-quoted strings ('' escapes), E'' strings (backslash escapes),
 * quoted identifiers, dollar-quoted strings and nested block comments. Text it
 * cannot scan to the end is refused. The extended query protocol (invariant 1)
 * is the control for multiple statements; this check names the refusal first.
 */
export type RefusedStatement = "not_text" | "transaction_control" | "multiple_statements" | "unparsable" | "not_data_statement" | "session_state" | "dynamic_sql"

/** Leading words that start a transaction-control statement on their own. */
const CONTROL_FIRST_WORDS: ReadonlySet<string> = new Set(["begin", "start", "commit", "end", "rollback", "abort", "savepoint", "release", "reset"])

type Scan = Readonly<{ statements: string[] }> | "unparsable"

const isIdentifierChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_$]/.test(char)

/** Splits `text` at top-level semicolons; strings, identifiers and comments are blanked, so only code words remain. */
function scan(text: string): Scan {
  const statements: string[] = []
  let current = ""
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    const next = text[i + 1]
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", i)
      i = end === -1 ? text.length : end + 1
      current += " "
    } else if (char === "/" && next === "*") {
      let depth = 1
      i += 2
      while (depth > 0) {
        if (i >= text.length) return "unparsable"
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++
          i += 2
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--
          i += 2
        } else i++
      }
      current += " "
    } else if ((char === "'" || char === '"') && text[i - 1] === "&" && (text[i - 2] === "U" || text[i - 2] === "u") && !isIdentifierChar(text[i - 3])) {
      // Repair wave 2: a Unicode-escaped string or identifier can spell any name; it is refused, not decoded.
      return "unparsable"
    } else if (char === "'") {
      const escapes = (text[i - 1] === "E" || text[i - 1] === "e") && !isIdentifierChar(text[i - 2])
      i++
      for (;;) {
        if (i >= text.length) return "unparsable"
        if (escapes && text[i] === "\\") i += 2
        else if (text[i] === "'" && text[i + 1] === "'") i += 2
        else if (text[i] === "'") break
        else i++
      }
      i++
      current += " '' "
    } else if (char === '"') {
      // Kept as written (quotes included), so a quoted function name is still seen; word checks skip it.
      const start = i
      i++
      for (;;) {
        if (i >= text.length) return "unparsable"
        if (text[i] === '"' && text[i + 1] === '"') i += 2
        else if (text[i] === '"') break
        else i++
      }
      i++
      current += ` ${text.slice(start, i).replaceAll(";", " ")} `
    } else if (char === "$" && !isIdentifierChar(text[i - 1]) && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))![0]
      const end = text.indexOf(tag, i + tag.length)
      if (end === -1) return "unparsable"
      i = end + tag.length
      current += " '' "
    } else if (char === ";") {
      statements.push(current)
      current = ""
      i++
    } else {
      current += char
      i++
    }
  }
  statements.push(current)
  return { statements: statements.filter((statement) => statement.trim() !== "") }
}

function isTransactionControl(code: string): boolean {
  const words = code.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []
  if (!/^\s*[A-Za-z_]/.test(code)) return false
  const [first, second, third, fourth] = words
  if (first !== undefined && CONTROL_FIRST_WORDS.has(first)) return true
  if (first === "prepare" && second === "transaction") return true
  if (first !== "set") return false
  const rest = second === "local" || second === "session" ? [third, fourth] : [second, third]
  if (rest[0] === "transaction") return true
  if (second === "session" && (third === "authorization" || third === "characteristics")) return true
  if (second === "local" && third === "session" && fourth === "authorization") return true
  return rest[0] === "session" && rest[1] === "authorization"
}

/**
 * Repair wave 2 (F-SEC-14): the statement kinds a scope may send. Each changes
 * rows or reads them and leaves nothing on the session once the transaction
 * ends. `SET LOCAL` also ends with the transaction. Everything else (SET,
 * CREATE, PREPARE, LISTEN, DO, COPY, LOCK, DECLARE, EXPLAIN, ...) is refused.
 */
const DATA_FIRST_WORDS: ReadonlySet<string> = new Set(["select", "insert", "update", "delete", "merge", "with"])

/** Functions that leave state on the session after the transaction ends: session advisory locks and their release. */
const SESSION_FUNCTIONS: ReadonlySet<string> = new Set(["pg_advisory_lock", "pg_advisory_lock_shared", "pg_try_advisory_lock", "pg_try_advisory_lock_shared", "pg_advisory_unlock", "pg_advisory_unlock_shared", "pg_advisory_unlock_all"])

/** Built-in functions that run SQL text they are given, which this check never sees. */
const DYNAMIC_SQL_FUNCTIONS: ReadonlySet<string> = new Set(["query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema", "ts_stat", "ts_rewrite"])

/** Words outside quoted identifiers, lower-cased. */
const codeWords = (code: string) => code.replace(/"(?:[^"]|"")*"/g, " ").toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []

/** Every function call in `code`: its name (a quoted name as written inside the quotes) and the text between its parentheses. */
function calls(code: string): Array<{ name: string; args: string }> {
  const found: Array<{ name: string; args: string }> = []
  const pattern = /("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\(/g
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
    const raw = match[1]!
    const name = raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase()
    let depth = 1
    let end = pattern.lastIndex
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth++
      else if (code[end] === ")") depth--
      end++
    }
    found.push({ name, args: code.slice(pattern.lastIndex, end - 1) })
  }
  return found
}

/** Top-level comma-separated arguments. */
function topLevelArguments(args: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of args) {
    if (char === "(") depth++
    if (char === ")") depth--
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else current += char
  }
  parts.push(current.trim())
  return parts
}

/** A data statement that is something else: `SELECT ... INTO` creates a table. */
function createsTable(words: readonly string[]): boolean {
  return words.some((word, index) => word === "into" && words[index - 1] !== "insert" && words[index - 1] !== "merge")
}

function isSetLocal(words: readonly string[]): boolean {
  return words[0] === "set" && words[1] === "local" && words[2] !== "role" && words[2] !== "session"
}

/** Why a scope refuses `text`, or undefined when it may run. Anything but a non-empty string is refused (F-SEC-13). */
export function refusedStatementReason(text: unknown): RefusedStatement | undefined {
  if (typeof text !== "string") return "not_text"
  const scanned = scan(text)
  if (scanned === "unparsable") return "unparsable"
  if (scanned.statements.length > 1) return "multiple_statements"
  const [statement] = scanned.statements
  if (statement === undefined) return "not_text"
  if (isTransactionControl(statement)) return "transaction_control"
  const words = codeWords(statement)
  const leading = statement.trimStart().replace(/^\(+\s*/, "")
  if (/^"/.test(leading)) return "not_data_statement"
  if (isSetLocal(words)) return undefined
  if (words[0] === undefined || !DATA_FIRST_WORDS.has(words[0]) || createsTable(words)) return "not_data_statement"
  for (const { name, args } of calls(statement)) {
    if (SESSION_FUNCTIONS.has(name)) return "session_state"
    if (DYNAMIC_SQL_FUNCTIONS.has(name)) return "dynamic_sql"
    if (name === "set_config") {
      const parts = topLevelArguments(args)
      if (parts.length !== 3 || parts[2]!.toLowerCase() !== "true") return "session_state"
    }
  }
  return undefined
}
