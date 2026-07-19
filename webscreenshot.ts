const LATCHSHOT_SCREENSHOT_URL = "https://latchshot.fly.dev/v1/screenshot"
const DEFAULT_SCREENSHOT_TIMEOUT_SECONDS = 30
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024

export interface ScreenshotParams {
  url: string
  width?: number
  height?: number
  fullPage?: boolean
  timeout?: number
}

export interface ScreenshotResult {
  mime: string
  base64: string
  bytes: number
  renderMs?: string
  quotaRemaining?: string
}

type ScreenshotUpdate = (update: {
  content: Array<{ type: "text"; text: string }>
  details: Record<string, unknown>
}) => void

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return resolved
}

async function responseBuffer(response: Response, onUpdate?: ScreenshotUpdate): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer())

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let lastReportedBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    receivedBytes += value.length
    if (receivedBytes > MAX_RESPONSE_SIZE) throw new Error("Screenshot exceeds the 10MB response limit")
    if (receivedBytes - lastReportedBytes > 20_000) {
      onUpdate?.({
        content: [{ type: "text", text: `Downloading screenshot... ${Math.round(receivedBytes / 1024)} KB received` }],
        details: {},
      })
      lastReportedBytes = receivedBytes
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export function takeScreenshotSlot(counts: Map<string, number>, sessionId: string, maximum = 10): void {
  const used = counts.get(sessionId) ?? 0
  if (used >= maximum) throw new Error(`webscreenshot is limited to ${maximum} captures per session`)
  counts.set(sessionId, used + 1)
}

export async function capturePublicPage(
  params: ScreenshotParams,
  signal?: AbortSignal,
  onUpdate?: ScreenshotUpdate,
): Promise<ScreenshotResult> {
  const apiKey = process.env.LATCHSHOT_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("LATCHSHOT_API_KEY is required for webscreenshot. Create a recurring Free-plan key at https://latchshot.fly.dev/?intent=piwebsearch#trial")
  }

  let target: URL
  try {
    target = new URL(params.url)
  } catch {
    throw new Error("URL must be a valid public http:// or https:// address")
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("URL must be a public http:// or https:// address")
  }
  if (target.username || target.password) {
    throw new Error("URL credentials are not supported; webscreenshot captures public pages only")
  }

  const width = boundedInteger(params.width, 1280, 320, 2560, "width")
  const height = boundedInteger(params.height, 720, 240, 1440, "height")
  const timeoutSeconds = boundedInteger(params.timeout, DEFAULT_SCREENSHOT_TIMEOUT_SECONDS, 3, 30, "timeout")
  const endpoint = new URL(LATCHSHOT_SCREENSHOT_URL)
  endpoint.searchParams.set("url", target.toString())
  endpoint.searchParams.set("width", String(width))
  endpoint.searchParams.set("height", String(height))
  endpoint.searchParams.set("format", "png")
  endpoint.searchParams.set("fullPage", String(params.fullPage ?? false))
  endpoint.searchParams.set("timeout", String(timeoutSeconds * 1000))
  endpoint.searchParams.set("reducedMotion", "true")

  onUpdate?.({
    content: [{ type: "text", text: `Capturing ${target.hostname} at ${width}×${height}...` }],
    details: {},
  })

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutSeconds * 1000 + 10_000)

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "image/png",
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      let message = "capture failed"
      try {
        const body = await response.json() as { error?: { message?: string } }
        if (body.error?.message) message = body.error.message
      } catch {
        // Keep the bounded public fallback; never include request headers or the key.
      }
      throw new Error(`Latchshot capture failed (HTTP ${response.status}): ${message}`)
    }

    const mime = (response.headers.get("content-type") || "image/png").split(";")[0]!.trim().toLowerCase()
    if (mime !== "image/png") {
      throw new Error(`Latchshot returned an unsupported content type: ${mime || "unknown"}`)
    }

    const buffer = await responseBuffer(response, onUpdate)
    return {
      mime,
      base64: buffer.toString("base64"),
      bytes: buffer.byteLength,
      renderMs: response.headers.get("x-latchshot-render-ms") || undefined,
      quotaRemaining: response.headers.get("x-quota-remaining") || undefined,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export function buildScreenshotToolResult(params: ScreenshotParams, result: ScreenshotResult) {
  const diagnostics = [
    `${result.bytes.toLocaleString()} bytes`,
    result.renderMs ? `${result.renderMs} ms render` : undefined,
    result.quotaRemaining ? `${result.quotaRemaining} quota remaining` : undefined,
  ].filter(Boolean).join(" · ")

  return {
    content: [{ type: "text" as const, text: `Captured ${params.url} as PNG (${diagnostics}).` }],
    details: {
      url: params.url,
      width: params.width ?? 1280,
      height: params.height ?? 720,
      fullPage: params.fullPage ?? false,
      contentType: result.mime,
      bytes: result.bytes,
      renderMs: result.renderMs,
      quotaRemaining: result.quotaRemaining,
    },
    attachments: [
      {
        type: "file" as const,
        mime: result.mime,
        url: `data:${result.mime};base64,${result.base64}`,
      },
    ],
  }
}
