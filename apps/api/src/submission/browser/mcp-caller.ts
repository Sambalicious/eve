import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/**
 * One Playwright MCP connection, held only by backend code (ADR 0008). Each
 * `call` sends exactly one `tools/call` request and never retries. A tool
 * error (`isError`) is thrown as `McpToolError`; the text content is returned
 * otherwise. No caller can list tools: nothing hands MCP tools to a model.
 */
export interface McpCaller {
  call(tool: PlaywrightTool, args: Readonly<Record<string, unknown>>): Promise<string>
  close(): Promise<void>
}

/** The Playwright MCP tools backend code uses. `browser_run_code_unsafe`, `browser_navigate_back`, `browser_press_key`, `browser_type` and the rest are never called. */
export type PlaywrightTool =
  | "browser_navigate"
  | "browser_evaluate"
  | "browser_fill_form"
  | "browser_select_option"
  | "browser_click"
  | "browser_file_upload"
  | "browser_snapshot"
  | "browser_take_screenshot"
  | "browser_wait_for"
  | "browser_close"

export class McpToolError extends Error {
  constructor(readonly tool: PlaywrightTool) {
    // The server's text can quote page content; it is not kept.
    super(`Playwright MCP tool ${tool} failed`)
    this.name = "McpToolError"
  }
}

export type McpCallerOptions = Readonly<{ url: string; attemptId: string; timeoutMs: number }>

/** Streamable HTTP client from `@modelcontextprotocol/sdk`, one per attempt. */
export async function connectMcp(options: McpCallerOptions): Promise<McpCaller> {
  const client = new Client({ name: `eve-${options.attemptId}`, version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(options.url)))
  return {
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: { ...args } }, undefined, { timeout: options.timeoutMs })
      if (result.isError) throw new McpToolError(tool)
      return textOf(result.content)
    },
    async close() {
      await client.close()
    },
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
}

/** `browser_evaluate` replies "### Result\n<json>"; the JSON value is returned, or undefined. */
export function evaluateResult(text: string): unknown {
  const marker = text.indexOf("### Result")
  if (marker < 0) return undefined
  const rest = text.slice(marker + "### Result".length).trim()
  const end = rest.search(/\n###\s/)
  const json = end >= 0 ? rest.slice(0, end) : rest
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}
