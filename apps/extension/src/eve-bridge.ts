/**
 * Injected into the Candidate's own Eve tab (ADR 0016). It is the extension's
 * only caller of the Eve API, and it uses the page's own session instead of an
 * extension credential: `GET /v1/session` for the CSRF token, then
 * `POST /v1/extension/fill` with the session cookie.
 *
 * After the review it also downloads the prepared PDFs the plan named, from
 * `GET /v1/applications/:id/documents/resume.pdf|cover-letter.pdf`, with the
 * same session cookie. The response is base64 so the bytes can cross the
 * background worker to the employer tab; the file name comes from the server's
 * `content-disposition` when it sends one.
 *
 * The session path is the one the web app uses (`SESSION_PATH` in
 * `packages/contracts/src/auth.ts`). The ADR writes it as `/v1/auth/session`;
 * the route the API serves is `/v1/session`.
 *
 * A classic script with no imports, injected with
 * `chrome.scripting.executeScript({ files })`. It installs
 * `globalThis.__eveBridge`, which the background worker calls in the same
 * isolated world with the form it read on the employer tab.
 */
void (() => {
  const EVE_SESSION_PATH = "/v1/session"
  const EVE_FILL_PATH = "/v1/extension/fill"
  const EVE_APPLICATIONS_PATH = "/v1/applications"
  const DOCUMENT_ROUTE: Readonly<Record<EveDocumentKind, string>> = { resume: "resume", cover_letter: "cover-letter" }
  const MAX_FILENAME = 200
  /** A prepared PDF over this size is refused rather than base64-inflated across two tabs. */
  const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
  /** Well under the argument limit of `String.fromCharCode(...)`, so a large PDF cannot overflow the call stack. */
  const BASE64_CHUNK = 0x8000
  /** Every request is bounded: a fetch that never settles must not leave the popup waiting on it. */
  const SESSION_TIMEOUT_MS = 10_000
  const FILL_TIMEOUT_MS = 20_000
  const DOWNLOAD_TIMEOUT_MS = 30_000

  function failed(status: number, error: EveBridgeError): EveBridgeResult {
    return { ok: false, status, error }
  }

  function failedDownload(status: number, error: EveBridgeError): EveBridgeDownloadResult {
    return { ok: false, status, error }
  }

  /**
   * A fetch that cannot outlive its bound. The timer aborts the request and
   * rejects even if the fetch itself never answers, so no caller waits forever.
   */
  function fetchWithin(url: string, init: RequestInit, ms: number): Promise<Response> {
    const controller = new AbortController()
    return new Promise<Response>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        return true
      }
      timer = setTimeout(() => {
        controller.abort()
        if (finish()) reject(new Error("Eve's request timed out."))
      }, ms)
      fetch(url, { ...init, signal: controller.signal }).then(
        (response) => {
          if (finish()) resolve(response)
        },
        (error: unknown) => {
          if (finish()) reject(error)
        }
      )
    })
  }

  /**
   * A file name the Candidate can see unchanged: no path separator, control
   * (C0, DEL or C1) or format character (a right-to-left override can disguise an extension), and
   * no `..` segment. Leading dots and stray whitespace go; the rest, including a
   * literal `%` and the `.pdf` the server named, is left as sent.
   */
  function sanitiseFilename(raw: string): string {
    return raw
      .replace(/[\\/\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, "")
      .replace(/\.{2,}/g, ".")
      .replace(/^[\s.]+/u, "")
      .trim()
  }

  /** The server's file name when it sends one, else the document's own name. */
  function filenameOf(response: Response, fallback: string): string {
    const header = response.headers.get("content-disposition") ?? ""
    const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
    const plain = /filename\s*=\s*([^;]+)/i.exec(header)
    const raw = (quoted?.[1] ?? plain?.[1] ?? "").trim()
    if (raw === "") return fallback
    const clean = sanitiseFilename(raw)
    return clean === "" ? fallback : clean.slice(0, MAX_FILENAME)
  }

  /** A PDF starts with `%PDF-`; a 200 that only claims to be one is not a document. */
  function startsWithPdfMagic(bytes: Uint8Array): boolean {
    const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]
    if (bytes.byteLength < magic.length) return false
    return magic.every((byte, index) => bytes[index] === byte)
  }

  /** Base64 in chunks: one spread of a whole PDF would exceed the engine's argument limit. */
  function base64Of(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
    }
    return btoa(binary)
  }

  async function download(applicationId: string, document: EveDocumentKind): Promise<EveBridgeDownloadResult> {
    const route = document === "resume" || document === "cover_letter" ? DOCUMENT_ROUTE[document] : null
    if (route === null) return failedDownload(0, "download")
    let response: Response
    try {
      response = await fetchWithin(
        `${EVE_APPLICATIONS_PATH}/${encodeURIComponent(applicationId)}/documents/${route}.pdf`,
        {
          credentials: "include",
          headers: { accept: "application/pdf" },
          // A redirect leaves the Eve origin, and its target is not the prepared PDF.
          redirect: "error",
        },
        DOWNLOAD_TIMEOUT_MS
      )
    } catch {
      // `redirect: "error"` rejects the same way a lost network does; neither yields a document.
      return failedDownload(0, "download")
    }
    if (response.status === 401) return failedDownload(401, "unauthorized")
    if (response.status === 403) return failedDownload(403, "forbidden")
    if (response.status === 404) return failedDownload(404, "not_available")
    if (!response.ok) return failedDownload(response.status, "download")
    // A signed-in HTML page is a 200 too: only the server's PDF type may become a file.
    if (!/^application\/pdf\b/i.test(response.headers.get("content-type") ?? "")) return failedDownload(response.status, "download")
    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      return failedDownload(response.status, "download")
    }
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) return failedDownload(response.status, "too_large")
    if (!startsWithPdfMagic(new Uint8Array(buffer))) return failedDownload(response.status, "download")
    return { ok: true, name: filenameOf(response, `${document}.pdf`), type: "application/pdf", base64: base64Of(buffer) }
  }

  async function fill(body: EveFillBody): Promise<EveBridgeResult> {
    let session: Response
    try {
      session = await fetchWithin(EVE_SESSION_PATH, { credentials: "include", headers: { accept: "application/json" } }, SESSION_TIMEOUT_MS)
    } catch {
      return failed(0, "network")
    }
    if (session.status === 401) return failed(401, "unauthorized")
    if (!session.ok) return failed(session.status, "session")

    let csrfToken = ""
    try {
      const payload = (await session.json()) as { csrfToken?: unknown }
      if (typeof payload.csrfToken === "string") csrfToken = payload.csrfToken
    } catch {
      return failed(session.status, "session")
    }
    if (csrfToken === "") return failed(session.status, "csrf")

    let response: Response
    try {
      response = await fetchWithin(
        EVE_FILL_PATH,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken, accept: "application/json" },
          body: JSON.stringify(body),
        },
        FILL_TIMEOUT_MS
      )
    } catch {
      return failed(0, "network")
    }
    if (response.status === 401) return failed(401, "unauthorized")
    if (!response.ok) return failed(response.status, "fill")
    try {
      return { ok: true, status: response.status, body: (await response.json()) as EveFillResponseBody }
    } catch {
      return failed(response.status, "fill")
    }
  }

  globalThis.__eveBridge = { fill, download }
})()
