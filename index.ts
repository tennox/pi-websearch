/**
 * Web Search + Web Fetch Extension for Pi
 *
 * Adapted from opencode's approach:
 * - websearch: Multiple providers via REST API or MCP JSON-RPC
 * - webfetch: direct HTTP fetch + HTML→markdown conversion
 *
 * API keys (search only):
 *   BRAVE_API_KEY       - Brave Search API key (optional)
 *   TAVILY_API_KEY      - Tavily Search API key (optional)
 *   GOOGLE_API_KEY      - Google Custom Search JSON API key (optional)
 *   GOOGLE_CX           - Google Programmable Search Engine ID (optional)
 *   SEARXNG_BASE_URL    - SearXNG instance base URL (optional)
 *   EXA_API_KEY         - Exa search (optional, works without it)
 *   PARALLEL_API_KEY    - Parallel search (optional, works without it)
 *   LATCHSHOT_API_KEY   - Latchshot public-page screenshots (optional)
 *
 * Override:
 *   PI_WEBSEARCH_PROVIDER=brave|tavily|google|searxng|exa|parallel
 *
 * Cache (Issue #2):
 *   PI_WEBSEARCH_CACHE_TTL  - Cache TTL in seconds (default: 300 / 5 minutes, 0 = disabled)
 *   PI_WEBSEARCH_CACHE_MAX  - Max cached search results (default: 100)
 *   PI_WEBSEARCH_CACHE      - Set to "off" to disable caching entirely
 */

import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import TurndownService from "turndown";
import { Parser, parseDocument } from "htmlparser2";
import { isTag, type AnyNode, type Element, type Document as DomDocument } from "domhandler";
import { removeElement, textContent, getElementsByTagName, getChildren, getAttributeValue } from "domutils";
import { render } from "dom-serializer";
import { extractText, getMeta, getDocumentProxy } from "unpdf";
import {
  buildScreenshotToolResult,
  capturePublicPage,
  takeScreenshotSlot,
  type ScreenshotParams,
} from "./webscreenshot.ts";

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

type ProviderName = "brave" | "tavily" | "google" | "searxng" | "exa" | "parallel";
type DateRange = "last_day" | "last_week" | "last_month" | "last_3m" | "last_6m" | "last_9m" | "last_year" | "ytd";

/**
 * Date range parameter mapping per provider.
 *
 * - For providers with preset values (Brave, Tavily, SearXNG), the map
 *   provides the exact API parameter.
 * - For providers supporting arbitrary date ranges (Brave custom range,
 *   Tavily start_date, Google m[N]/d[N], Exa ISO date), the map entry
 *   may use a special sentinel that triggers runtime date computation
 *   inside resolveDateParams().
 * - Providers that don't support date filtering (Parallel) simply
 *   have an empty record — resolveDateParams() returns {}.
 * - SearXNG only supports 4 presets (day/week/month/year); intermediate
 *   ranges fall back to the closest available preset.
 */
const DATE_RANGE_MAP: Record<string, Partial<Record<DateRange, Record<string, string>>>> = {
  brave: {
    last_day:   { freshness: "pd" },
    last_week:  { freshness: "pw" },
    last_month: { freshness: "pm" },
    last_3m:    { freshness: "__BRAVE_CUSTOM__" },   // computed at runtime
    last_6m:    { freshness: "__BRAVE_CUSTOM__" },   // computed at runtime
    last_9m:    { freshness: "__BRAVE_CUSTOM__" },   // computed at runtime
    last_year:  { freshness: "py" },
    ytd:        { freshness: "__BRAVE_CUSTOM__" },   // computed at runtime
  },
  tavily: {
    last_day:   { time_range: "day" },
    last_week:  { time_range: "week" },
    last_month: { time_range: "month" },
    last_3m:    { __TAVILY_START_DATE__: "" },      // computed at runtime
    last_6m:    { __TAVILY_START_DATE__: "" },      // computed at runtime
    last_9m:    { __TAVILY_START_DATE__: "" },      // computed at runtime
    last_year:  { time_range: "year" },
    ytd:        { __TAVILY_START_DATE__: "" },      // computed at runtime
  },
  google: {
    last_day:   { dateRestrict: "d1" },
    last_week:  { dateRestrict: "w1" },
    last_month: { dateRestrict: "m1" },
    last_3m:    { dateRestrict: "m3" },
    last_6m:    { dateRestrict: "m6" },
    last_9m:    { dateRestrict: "m9" },
    last_year:  { dateRestrict: "y1" },
    ytd:        { dateRestrict: "__GOOGLE_D__" },    // computed at runtime
  },
  searxng: {
    last_day:   { time_range: "day" },
    last_week:  { time_range: "week" },
    last_month: { time_range: "month" },
    last_3m:    { time_range: "month" },              // falls back to closest preset
    last_6m:    { time_range: "year" },               // falls back to closest preset
    last_9m:    { time_range: "year" },               // falls back to closest preset
    last_year:  { time_range: "year" },
    ytd:        { time_range: "year" },               // falls back to closest preset
  },
  // Exa uses ISO date computation — handled by resolveDateParams()
  exa: {},
  // Parallel doesn't support date filtering — silently ignored
  parallel: {},
};

/** Day offsets for computing ISO date boundaries (Exa-style providers). */
const DATE_RANGE_DAYS: Record<DateRange, number> = {
  last_day:   1,
  last_week:  7,
  last_month: 30,
  last_3m:   90,
  last_6m:   180,
  last_9m:   270,
  last_year:  365,
  ytd:        0,  // computed at runtime
};

/** Human-readable labels for display in UI. */
const DATE_RANGE_LABELS: Record<DateRange, string> = {
  last_day:   "24h",
  last_week:  "7d",
  last_month: "30d",
  last_3m:   "3m",
  last_6m:   "6m",
  last_9m:   "9m",
  last_year:  "1y",
  ytd:        "YTD",
};

/** Compute YTD day offset (days since Jan 1 of current year). */
function ytdDays(): number {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return Math.floor((now.getTime() - jan1.getTime()) / 86400000);
}

function toISODate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

function toBraveDateRange(daysAgo: number): string {
  const start = new Date(Date.now() - daysAgo * 86400000);
  const end = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(start)}to${fmt(end)}`;
}

function resolveDateParams(provider: string, dateRange?: DateRange): Record<string, unknown> {
  if (!dateRange) return {};

  // Check for sentinel values that require runtime date computation
  const preset = DATE_RANGE_MAP[provider]?.[dateRange];

  if (preset && Object.keys(preset).length > 0) {
    const key = Object.keys(preset)[0]!;
    const val = preset[key]!;

    // Brave custom date range: compute YYYY-MM-DDtoYYYY-MM-DD
    if (val === "__BRAVE_CUSTOM__") {
      const days = dateRange === "ytd" ? ytdDays() : DATE_RANGE_DAYS[dateRange];
      return { freshness: toBraveDateRange(days) };
    }

    // Tavily start_date: compute YYYY-MM-DD
    if (val === "") {
      const days = dateRange === "ytd" ? ytdDays() : DATE_RANGE_DAYS[dateRange];
      return { start_date: toISODate(days).slice(0, 10) };
    }

    // Google YTD: compute d<N> (days since Jan 1)
    if (val === "__GOOGLE_D__") {
      return { dateRestrict: `d${ytdDays()}` };
    }

    // Regular preset
    return { ...preset };
  }

  // For providers that need ISO date computation (Exa)
  // If the provider has an empty entry in DATE_RANGE_MAP, it means
  // we should compute the ISO date instead.
  if (provider in DATE_RANGE_MAP) {
    const days = dateRange === "ytd" ? ytdDays() : DATE_RANGE_DAYS[dateRange];
    const startDate = new Date(Date.now() - days * 86400000);
    return { startPublishedDate: startDate.toISOString() };
  }

  // Unknown provider — no date filtering
  return {};
}

interface SearchProvider {
  name: ProviderName;
  isAvailable(): boolean;
  search(query: string, numResults: number, sessionId: string, signal: AbortSignal | undefined, dateRange?: DateRange): Promise<string>;
}

class SearchError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "SearchError";
  }
}

class SearchAuthError extends SearchError {
  constructor(provider: string, status: number) {
    super(`${provider} API key invalid or expired (HTTP ${status})`, "AUTH_ERROR");
    this.name = "SearchAuthError";
  }
}

class SearchRateLimitError extends SearchError {
  constructor(provider: string) {
    super(`${provider} rate limit exceeded`, "RATE_LIMIT");
    this.name = "SearchRateLimitError";
  }
}

class SearchServerError extends SearchError {
  constructor(provider: string, status: number) {
    super(`${provider} search service error (HTTP ${status})`, "SERVER_ERROR");
    this.name = "SearchServerError";
  }
}

// ---------------------------------------------------------------------------
// Provider priority (higher = tried first during auto-selection and fallback)
// ---------------------------------------------------------------------------

const PROVIDER_PRIORITY: ProviderName[] = ["brave", "tavily", "google", "searxng", "exa", "parallel"];

// ---------------------------------------------------------------------------
// Deterministic provider selection
// ---------------------------------------------------------------------------

function checksum(input: string): string | undefined {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isProviderName(value: string): value is ProviderName {
  return PROVIDER_PRIORITY.includes(value as ProviderName);
}

function getAvailableProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  if (process.env.BRAVE_API_KEY) available.push("brave");
  if (process.env.TAVILY_API_KEY) available.push("tavily");
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) available.push("google");
  if (process.env.SEARXNG_BASE_URL) available.push("searxng");
  available.push("exa", "parallel"); // always available
  return available;
}

function selectSearchProvider(sessionId: string): ProviderName {
  const override = process.env.PI_WEBSEARCH_PROVIDER;
  if (override && isProviderName(override)) return override;

  const available = getAvailableProviders();

  // If user configured keys for premium providers, pick the highest-priority available one
  for (const p of PROVIDER_PRIORITY) {
    if (available.includes(p) && p !== "exa" && p !== "parallel") {
      return p;
    }
  }

  // No premium keys: deterministic hash split between Exa and Parallel (same as opencode)
  const hash = Number.parseInt(checksum(sessionId) ?? "0", 36);
  return hash % 2 === 0 ? "exa" : "parallel";
}

function getFallbackChain(preferred: ProviderName): ProviderName[] {
  const available = getAvailableProviders();
  // Remove preferred, keep rest in priority order
  return PROVIDER_PRIORITY.filter((p) => p !== preferred && available.includes(p));
}

// ---------------------------------------------------------------------------
// Search result cache (Issue #2: TTL-based caching with LRU eviction)
// ---------------------------------------------------------------------------

interface CacheEntry {
  rawResult: string;       // pre-truncation result so re-reads get fresh temp files
  details: Record<string, unknown>;
  timestamp: number;       // Date.now() when cached
}

class SearchCache {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly enabled: boolean,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  private makeKey(provider: string, query: string, dateRange: string | undefined, numResults: number): string {
    return `${provider}:${query.toLowerCase().trim()}:${dateRange ?? "none"}:${numResults}`;
  }

  get(provider: string, query: string, dateRange: string | undefined, numResults: number): CacheEntry | undefined {
    if (!this.enabled) return undefined;
    const key = this.makeKey(provider, query, dateRange, numResults);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp >= this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: delete + re-insert moves to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(provider: string, query: string, dateRange: string | undefined, numResults: number, rawResult: string, details: Record<string, unknown>): void {
    if (!this.enabled) return;
    const key = this.makeKey(provider, query, dateRange, numResults);
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      // Evict least recently used (first in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { rawResult, details, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Result formatter
// ---------------------------------------------------------------------------

function formatSearchResults(results: Array<{ title: string; url: string; snippet?: string; content?: string }>): string {
  if (results.length === 0) return "No search results found.";
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. [${r.title}](${r.url})`);
    const text = r.content || r.snippet || "";
    if (text) {
      lines.push(text.trim());
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// MCP call (mirrors opencode's mcp-websearch.ts)
// ---------------------------------------------------------------------------

const MCP_TIMEOUT_MS = 25_000;

function parseMcpResponse(body: string): string | undefined {
  const tryParse = (payload: string): string | undefined => {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const data = JSON.parse(trimmed);
      const content: { type: string; text: string }[] = data?.result?.content;
      return content?.find((item) => item.text)?.text;
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(body);
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = tryParse(line.substring(6));
    if (data) return data;
  }

  return undefined;
}

async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${tool} returned HTTP ${response.status}`);
    }

    return parseMcpResponse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// REST search helpers
// ---------------------------------------------------------------------------

async function safeFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      throw new SearchAuthError(provider, response.status);
    }
    if (response.status === 429) {
      throw new SearchRateLimitError(provider);
    }
    if (response.status >= 500) {
      throw new SearchServerError(provider, response.status);
    }
    if (!response.ok) {
      throw new SearchError(`${provider} search failed (HTTP ${response.status})`, "HTTP_ERROR");
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Search providers
// ---------------------------------------------------------------------------

function exaUrl(): string {
  const key = process.env.EXA_API_KEY;
  return key
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}`
    : "https://mcp.exa.ai/mcp";
}

async function searchExa(query: string, numResults?: number, dateRange?: DateRange): Promise<string> {
  const args: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: numResults ?? 8,
    livecrawl: "fallback",
  };
  const dateParams = resolveDateParams("exa", dateRange);
  Object.assign(args, dateParams);

  const result = await mcpCall(exaUrl(), "web_search_exa", args);
  if (!result) throw new SearchError("Exa returned no results", "EMPTY");
  return result;
}

async function searchParallel(query: string, sessionId?: string, dateRange?: DateRange): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "pi-coding-agent",
  };
  const key = process.env.PARALLEL_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;

  // Parallel doesn't support date filtering — dateRange is silently ignored
  const result = await mcpCall("https://search.parallel.ai/mcp", "web_search", {
    objective: query,
    search_queries: [query],
    session_id: sessionId,
  }, headers);
  if (!result) throw new SearchError("Parallel returned no results", "EMPTY");
  return result;
}

async function searchBrave(query: string, numResults?: number, dateRange?: DateRange): Promise<string> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new SearchError("BRAVE_API_KEY not set", "CONFIG");

  const count = Math.min(numResults ?? 8, 20);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("offset", "0");
  url.searchParams.set("search_lang", "en");

  // Apply date range filter
  const dateParams = resolveDateParams("brave", dateRange);
  for (const [k, v] of Object.entries(dateParams)) {
    url.searchParams.set(k, String(v));
  }

  const response = await safeFetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
  }, "brave");

  const data = await response.json() as {
    web?: {
      results?: Array<{ title: string; url: string; description?: string }>;
    };
  };

  const results = data.web?.results ?? [];
  return formatSearchResults(results.map((r) => ({ title: r.title, url: r.url, snippet: r.description })));
}

async function searchTavily(query: string, numResults?: number, dateRange?: DateRange): Promise<string> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError("TAVILY_API_KEY not set", "CONFIG");

  const body: Record<string, unknown> = {
    api_key: key,
    query,
    search_depth: "basic",
    max_results: numResults ?? 8,
    include_answer: false,
    include_images: false,
    include_raw_content: false,
  };

  // Apply date range filter
  Object.assign(body, resolveDateParams("tavily", dateRange));

  const response = await safeFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  }, "tavily");

  const data = await response.json() as {
    results?: Array<{ title: string; url: string; content?: string }>;
  };

  const results = data.results ?? [];
  return formatSearchResults(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })));
}

async function searchGoogle(query: string, numResults?: number, dateRange?: DateRange): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!key || !cx) throw new SearchError("GOOGLE_API_KEY and GOOGLE_CX must be set", "CONFIG");

  const num = Math.min(numResults ?? 8, 10);
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(num));

  // Apply date range filter
  const dateParams = resolveDateParams("google", dateRange);
  for (const [k, v] of Object.entries(dateParams)) {
    url.searchParams.set(k, String(v));
  }

  const response = await safeFetch(url.toString(), { headers: { Accept: "application/json" } }, "google");

  const data = await response.json() as {
    items?: Array<{ title: string; link: string; snippet?: string }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new SearchError(`Google API error: ${data.error.message ?? "unknown"}`, "API_ERROR");
  }

  const items = data.items ?? [];
  return formatSearchResults(items.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })));
}

async function searchSearxng(query: string, numResults?: number, dateRange?: DateRange): Promise<string> {
  const baseUrl = process.env.SEARXNG_BASE_URL;
  if (!baseUrl) throw new SearchError("SEARXNG_BASE_URL not set", "CONFIG");

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  url.searchParams.set("pageno", "1");
  if (numResults) url.searchParams.set("max_results", String(numResults));

  // Apply date range filter
  const dateParams = resolveDateParams("searxng", dateRange);
  for (const [k, v] of Object.entries(dateParams)) {
    url.searchParams.set(k, String(v));
  }

  const response = await safeFetch(url.toString(), { headers: { Accept: "application/json" } }, "searxng");

  const data = await response.json() as {
    results?: Array<{ title: string; url: string; content?: string; snippet?: string }>;
  };

  const results = data.results ?? [];
  return formatSearchResults(
    results.map((r) => ({ title: r.title, url: r.url, snippet: r.content || r.snippet })),
  );
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

function createProvider(name: ProviderName): SearchProvider {
  return {
    name,
    isAvailable() {
      switch (name) {
        case "brave": return !!process.env.BRAVE_API_KEY;
        case "tavily": return !!process.env.TAVILY_API_KEY;
        case "google": return !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX);
        case "searxng": return !!process.env.SEARXNG_BASE_URL;
        case "exa": return true;
        case "parallel": return true;
      }
    },
    search(query, numResults, sessionId, signal, dateRange) {
      if (signal?.aborted) return Promise.reject(new SearchError("Search aborted", "ABORTED"));
      switch (name) {
        case "brave": return searchBrave(query, numResults, dateRange);
        case "tavily": return searchTavily(query, numResults, dateRange);
        case "google": return searchGoogle(query, numResults, dateRange);
        case "searxng": return searchSearxng(query, numResults, dateRange);
        case "exa": return searchExa(query, numResults, dateRange);
        case "parallel": return searchParallel(query, sessionId, dateRange);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Web fetch (same approach as opencode's webfetch.ts)
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB
const DEFAULT_FETCH_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_FETCH_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_SCREENSHOTS_PER_SESSION = 10

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

function isPdfMime(mime: string): boolean {
  return mime === "application/pdf"
}

async function streamResponseToBuffer(
  response: Response,
  onUpdate?: AgentToolUpdateCallback<unknown>,
  label = "Fetching",
): Promise<Buffer> {
  if (!response.body) {
    const ab = await response.arrayBuffer()
    return Buffer.from(ab)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let lastReportedBytes = 0
  const contentLength = response.headers.get("content-length")
  const totalBytes = contentLength ? parseInt(contentLength) : undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    chunks.push(value)
    receivedBytes += value.length

    if (receivedBytes > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }

    if (receivedBytes - lastReportedBytes > 20_000) {
      let msg: string
      if (totalBytes && totalBytes > 0) {
        const pct = Math.round((receivedBytes / totalBytes) * 100)
        msg = `${label}... ${Math.round(receivedBytes / 1024)} KB / ${Math.round(totalBytes / 1024)} KB (${pct}%)`
      } else {
        msg = `${label}... ${Math.round(receivedBytes / 1024)} KB received`
      }
      onUpdate?.({ content: [{ type: "text", text: msg }], details: {} })
      lastReportedBytes = receivedBytes
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

// ---------------------------------------------------------------------------
// Auto-extract main content from fetched HTML (Issue #21)
// ---------------------------------------------------------------------------

const NOISE_TAGS = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
])

const NOISE_PATTERNS = [
  /cookie|consent|gdpr|banner/i,
  /ad-|ads-|advertisement|promo/i,
  /sidebar|widget|newsletter|subscribe/i,
  /social|share-|follow-us/i,
  /comment|disqus/i,
  /popup|modal|overlay/i,
]

function isNoiseElement(node: AnyNode): boolean {
  if (!isTag(node)) return false
  const tag = node.name.toLowerCase()
  if (NOISE_TAGS.has(tag)) return true
  const id = getAttributeValue(node, "id") || ""
  const cls = getAttributeValue(node, "class") || ""
  const combined = `${id} ${cls}`
  return NOISE_PATTERNS.some((p) => p.test(combined))
}

function removeNoiseNodes(node: AnyNode): void {
  if (!isTag(node)) return
  const children = getChildren(node).slice()
  for (const child of children) {
    if (isNoiseElement(child)) {
      removeElement(child)
    } else {
      removeNoiseNodes(child)
    }
  }
}

function extractMainContent(doc: DomDocument): AnyNode[] {
  const articles = getElementsByTagName("article", doc)
  const mains = getElementsByTagName("main", doc)
  const semantic: AnyNode[] = []
  if (articles.length > 0) semantic.push(...articles)
  if (mains.length > 0) semantic.push(...mains)
  if (semantic.length > 0) {
    return semantic
  }

  // Fallback heuristic: recursively find the block-level element with
  // the highest text-to-tag density inside <body>.
  const body = getElementsByTagName("body", doc)[0]
  if (!body) return [doc]

  let best: Element | null = null
  let bestScore = 0

  function walk(node: AnyNode): void {
    if (!isTag(node)) return
    if (isNoiseElement(node)) return
    const tag = node.name.toLowerCase()
    if (tag === "div" || tag === "section") {
      const txt = textContent(node).length
      // Simple density: text chars / (1 + number of child tags).  We approximate
      // by counting how many tag children exist.  A higher score means more text
      // per markup, i.e. likely the main article container.
      const childTags = getChildren(node).filter((c) => isTag(c)).length
      const density = txt / (1 + childTags)
      // Prefer larger containers, but boost by density so a giant wrapper
      // full of wrappers doesn't win over the actual content div.
      const score = txt + density * 10
      if (score > bestScore) {
        bestScore = score
        best = node
      }
    }
    for (const child of getChildren(node)) {
      walk(child)
    }
  }

  walk(body)

  return best ? [best] : [doc]
}

function cleanAndExtractHTML(html: string): string {
  const doc = parseDocument(html, { lowerCaseAttributeNames: true })
  // Remove noise from the root down
  for (const child of getChildren(doc).slice()) {
    if (isNoiseElement(child)) {
      removeElement(child)
    } else {
      removeNoiseNodes(child)
    }
  }
  const mainNodes = extractMainContent(doc)
  if (mainNodes.length === 1 && mainNodes[0] === doc) {
    return render(doc)
  }
  const cleaned = render(mainNodes)
  // Never return empty; fallback to original if extraction wiped everything
  if (!cleaned.trim()) return html
  return cleaned
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

interface PdfExtractionResult {
  text: string
  pages: number
  metadata?: PageMetadata
}

async function extractTextFromPDF(buffer: Buffer): Promise<PdfExtractionResult> {
  const uint8 = new Uint8Array(buffer)
  try {
    const doc = await getDocumentProxy(uint8)
    const meta = await getMeta(doc)
    const result = await extractText(doc)

    // Build page-marked text
    const parts: string[] = []
    for (let i = 0; i < result.text.length; i++) {
      const pageText = result.text[i]?.trim()
      if (pageText) {
        parts.push(`--- Page ${i + 1} ---`)
        parts.push(pageText)
        parts.push("")
      }
    }

    const metadata: PageMetadata = {
      title: meta.info?.Title || undefined,
      author: meta.info?.Author || undefined,
    }

    return { text: parts.join("\n").trim(), pages: result.totalPages, metadata }
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (msg.toLowerCase().includes("password") || err?.name === "PasswordException") {
      throw new Error("This PDF is password-protected and cannot be read.")
    }
    throw new Error(`Failed to extract text from PDF: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Structured metadata extraction (Issue #15)
// ---------------------------------------------------------------------------

interface PageMetadata {
  title?: string
  description?: string
  author?: string
  publishedDate?: string
  canonicalUrl?: string
  image?: string
  siteName?: string
  type?: string
}

function extractMetadata(html: string): PageMetadata {
  const og: Record<string, string> = {}
  const meta: Record<string, string> = {}
  const jsonLdScripts: string[] = []
  let title = ""
  let canonical = ""

  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "meta") {
        const prop = attributes.property
        const nameAttr = attributes.name
        const content = attributes.content
        if (prop && content) {
          og[prop] = content
        } else if (nameAttr && content) {
          meta[nameAttr.toLowerCase()] = content
        }
      } else if (name === "title") {
        // will collect text in ontext
      } else if (name === "link" && attributes.rel === "canonical" && attributes.href) {
        canonical = attributes.href
      } else if (name === "script" && attributes.type === "application/ld+json") {
        // will collect text in ontext
      }
    },
    ontext(text) {
      const currentTag = (parser as unknown as { _tagname?: string })._tagname
      if (currentTag === "title") {
        title = text
      }
      // htmlparser2 doesn't expose current tag easily in ontext,
      // so we handle JSON-LD by finding script blocks in raw html instead.
    },
  })

  // Parse meta, title, canonical, og tags
  parser.write(html)
  parser.end()

  // Extract title via regex fallback since htmlparser2 ontext is tricky inline
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) {
    title = titleMatch[1].replace(/\s+/g, " ").trim()
  }

  // Extract JSON-LD blocks
  const ldJsonRe = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = ldJsonRe.exec(html)) !== null) {
    jsonLdScripts.push(m[1].trim())
  }

  // Parse JSON-LD candidates
  let jsonLd: Record<string, unknown> | undefined
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script) as Record<string, unknown> | Record<string, unknown>[]
      const candidates = Array.isArray(data) ? data : [data]
      // Prefer Article, NewsArticle, BlogPosting, WebPage schemas
      const preferred = candidates.find(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (["Article", "NewsArticle", "BlogPosting", "WebPage", "Product", "Organization"].includes(
            String(c["@type"]),
          )),
      )
      jsonLd = preferred ?? candidates[0]
      if (jsonLd) break
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Helper to safely get nested string fields from JSON-LD
  function ldString(path: string[]): string | undefined {
    if (!jsonLd) return undefined
    let current: unknown = jsonLd
    for (const key of path) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key]
      } else {
        return undefined
      }
    }
    return typeof current === "string" ? current : undefined
  }

  function ldAuthor(): string | undefined {
    if (!jsonLd) return undefined
    const author = jsonLd.author
    if (typeof author === "string") return author
    if (author && typeof author === "object") {
      const name = (author as Record<string, unknown>).name
      if (typeof name === "string") return name
    }
    const creator = jsonLd.creator
    if (typeof creator === "string") return creator
    if (creator && typeof creator === "object") {
      const name = (creator as Record<string, unknown>).name
      if (typeof name === "string") return name
    }
    return undefined
  }

  function ldImage(): string | undefined {
    if (!jsonLd) return undefined
    const image = jsonLd.image
    if (typeof image === "string") return image
    if (image && typeof image === "object") {
      const url = (image as Record<string, unknown>).url
      if (typeof url === "string") return url
    }
    return undefined
  }

  // Merge with priority: OpenGraph > JSON-LD > HTML meta
  return {
    title: og["og:title"] || ldString(["headline"]) || title || meta.description || undefined,
    description: og["og:description"] || ldString(["description"]) || meta.description || undefined,
    author: og["og:article:author"] || ldAuthor() || meta.author || undefined,
    publishedDate: og["og:article:published_time"] || ldString(["datePublished"]) || meta.date || undefined,
    canonicalUrl: og["og:url"] || canonical || undefined,
    image: og["og:image"] || ldImage() || undefined,
    siteName: og["og:site_name"] || undefined,
    type: og["og:type"] || (jsonLd ? String(jsonLd["@type"]).toLowerCase() : undefined),
  }
}

async function fetchUrl(
  url: string,
  format: "text" | "markdown" | "html",
  timeoutSec?: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{ content: string; contentType: string; isImage: boolean; imageMime?: string; imageBase64?: string; metadata?: PageMetadata }> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://")
  }

  const timeout = Math.min((timeoutSec ?? DEFAULT_FETCH_TIMEOUT / 1000) * 1000, MAX_FETCH_TIMEOUT)

  // Build Accept header based on requested format (same as opencode)
  let acceptHeader = "*/*"
  switch (format) {
    case "markdown":
      acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      break
    case "text":
      acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
      break
    case "html":
      acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
      break
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptHeader,
    "Accept-Language": "en-US,en;q=0.9",
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // Also respect the outer signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  let response: Response
  try {
    response = await fetch(url, { headers, signal: controller.signal })

    // Retry with honest UA if blocked by Cloudflare bot detection (same as opencode)
    if (
      response.status === 403 &&
      response.headers.get("cf-mitigated") === "challenge"
    ) {
      response = await fetch(url, {
        headers: { ...headers, "User-Agent": "opencode" },
        signal: controller.signal,
      })
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  // Check content length
  const contentLength = response.headers.get("content-length")
  if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 10MB limit)")
  }

  const contentType = response.headers.get("content-type") || ""
  const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""

  // Also check URL extension as fallback for PDF detection
  const urlPath = new URL(url).pathname.toLowerCase()
  const isPdf = isPdfMime(mime) || urlPath.endsWith(".pdf")

  if (isImageMime(mime)) {
    const buffer = await streamResponseToBuffer(response, onUpdate, "Downloading image")
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }
    const base64Content = buffer.toString("base64")
    return {
      content: "Image fetched successfully",
      contentType,
      isImage: true,
      imageMime: mime,
      imageBase64: base64Content,
    }
  }

  if (isPdf) {
    const buffer = await streamResponseToBuffer(response, onUpdate, "Downloading PDF")
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }
    onUpdate?.({ content: [{ type: "text", text: `Extracting PDF text (${Math.round(buffer.byteLength / 1024)} KB)...` }], details: {} })
    const pdfResult = await extractTextFromPDF(buffer)

    let content = pdfResult.text
    if (format === "html") {
      content = `<pre>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
    }

    return {
      content,
      contentType,
      isImage: false,
      metadata: pdfResult.metadata,
    }
  }

  let text: string

  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let chunks = ""
    let receivedBytes = 0
    let lastReportedBytes = 0
    const totalBytes = contentLength ? parseInt(contentLength) : undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      receivedBytes += value.length
      if (receivedBytes > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 10MB limit)")
      }

      chunks += decoder.decode(value, { stream: true })

      if (receivedBytes - lastReportedBytes > 20_000) {
        let msg: string
        if (totalBytes && totalBytes > 0) {
          const pct = Math.round((receivedBytes / totalBytes) * 100)
          msg = `Fetching... ${Math.round(receivedBytes / 1024)} KB / ${Math.round(totalBytes / 1024)} KB (${pct}%)`
        } else {
          msg = `Fetching... ${Math.round(receivedBytes / 1024)} KB received`
        }
        onUpdate?.({ content: [{ type: "text", text: msg }], details: {} })
        lastReportedBytes = receivedBytes
      }
    }

    chunks += decoder.decode()
    text = chunks
  } else {
    text = await response.text()
  }

  // Handle content based on requested format and actual content type (same as opencode)
  const metadata = extractMetadata(text)
  switch (format) {
    case "markdown":
      if (contentType.includes("text/html")) {
        const cleaned = cleanAndExtractHTML(text)
        return { content: convertHTMLToMarkdown(cleaned), contentType, isImage: false, metadata }
      }
      return { content: text, contentType, isImage: false, metadata }

    case "text":
      if (contentType.includes("text/html")) {
        const cleaned = cleanAndExtractHTML(text)
        return { content: extractTextFromHTML(cleaned), contentType, isImage: false, metadata }
      }
      return { content: text, contentType, isImage: false, metadata }

    case "html":
      return { content: text, contentType, isImage: false, metadata }

    default:
      return { content: text, contentType, isImage: false, metadata }
  }
}

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    const tmpFile = join(mkdtempSync(join(tmpdir(), "pi-search-")), "output.md");
    writeFileSync(tmpFile, output, "utf8");

    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tmpFile}]`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(
    Type.Number({ description: "Number of search results to return (default: 8)" }),
  ),
  dateRange: Type.Optional(
    Type.Union(
      [
        Type.Literal("last_day"),
        Type.Literal("last_week"),
        Type.Literal("last_month"),
        Type.Literal("last_3m"),
        Type.Literal("last_6m"),
        Type.Literal("last_9m"),
        Type.Literal("last_year"),
        Type.Literal("ytd"),
      ],
      {
        description:
          "Filter results by recency: last_day (24h), last_week (7d), last_month (30d), last_3m (90d), last_6m (180d), last_9m (270d), last_year (365d), ytd (year-to-date). Use for time-sensitive queries like news, recent events, or latest updates.",
      },
    ),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch content from" }),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
      description: 'Format to return content in: "text", "markdown", or "html". Defaults to "markdown".',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Optional timeout in seconds (max 120)" }),
  ),
});

const WebScreenshotParams = Type.Object({
  url: Type.String({ description: "Public http:// or https:// webpage to capture" }),
  width: Type.Optional(
    Type.Number({ minimum: 320, maximum: 2560, description: "Viewport width in pixels (default: 1280)" }),
  ),
  height: Type.Optional(
    Type.Number({ minimum: 240, maximum: 1440, description: "Viewport height in pixels (default: 720)" }),
  ),
  fullPage: Type.Optional(
    Type.Boolean({ description: "Capture the full scrollable page (default: false)" }),
  ),
  timeout: Type.Optional(
    Type.Number({ minimum: 3, maximum: 30, description: "Browser timeout in seconds (default/max: 30)" }),
  ),
});

export default function webSearchExtension(pi: ExtensionAPI) {
  const year = new Date().getFullYear();

  // PI_WEBSEARCH_DATE_RANGE=0 disables the dateRange parameter entirely
  const dateRangeEnabled = process.env.PI_WEBSEARCH_DATE_RANGE !== "0";

  // --- Cache configuration (Issue #2) ---
  const cacheDisabled = (process.env.PI_WEBSEARCH_CACHE ?? "").toLowerCase() === "off";
  const cacheTtlRaw = parseInt(process.env.PI_WEBSEARCH_CACHE_TTL ?? "300", 10);
  const cacheTtlSec = Number.isNaN(cacheTtlRaw) ? 300 : cacheTtlRaw;
  const cacheMaxEntries = parseInt(process.env.PI_WEBSEARCH_CACHE_MAX ?? "100", 10) || 100;
  const searchCache = new SearchCache(
    !cacheDisabled,
    cacheTtlSec * 1000,   // convert to ms
    cacheMaxEntries,
  );
  const screenshotCounts = new Map<string, number>();

  // --- websearch ---

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description: [
      "Search the web for up-to-date information.",
      "Returns content from the most relevant websites for the given query.",
      "Use this tool when you need information beyond your knowledge cutoff, current events, or recent data.",
      "",
      `The current year is ${year}. You MUST use this year when searching for recent information or current events.`,
      `Example: If the current year is ${year} and the user asks for "latest AI news", search for "AI news ${year}"`,
      "",
      "For time-sensitive queries, use the dateRange parameter to filter results by recency:",
      '- Use "last_day" for very recent events (today/yesterday)',
      '- Use "last_week" for recent news and updates (past 7 days)',
      '- Use "last_month" for trends and changes in the past month',
      '- Use "last_3m" for results from the past 3 months',
      '- Use "last_6m" for results from the past 6 months',
      '- Use "last_9m" for results from the past 9 months',
      '- Use "last_year" for broader recent history (past 365 days)',
      '- Use "ytd" for results from the start of the current calendar year',
      "- Omit dateRange if recency is not important",
    ].join("\n"),
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use websearch when you need current information beyond your knowledge cutoff.",
      "Always include the current year in search queries about recent events.",
      "Use dateRange (last_day/last_week/last_month/last_3m/last_6m/last_9m/last_year/ytd) for time-sensitive queries like news or recent updates.",
    ],
    parameters: WebSearchParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionFile() ?? "default";
      const preferred = selectSearchProvider(sessionId);
      const fallbackChain = getFallbackChain(preferred);
      const providersToTry = [preferred, ...fallbackChain];

      // Strip dateRange if disabled via environment variable
      const effectiveDateRange = dateRangeEnabled ? (params.dateRange as DateRange | undefined) : undefined;
      const effectiveNumResults = params.numResults ?? 8;

      // Check cache (Issue #2)
      const cached = searchCache.get(preferred, params.query, effectiveDateRange, effectiveNumResults);
      if (cached) {
        return {
          content: [{ type: "text", text: truncateOutput(cached.rawResult) }],
          details: { ...cached.details, cached: true },
        };
      }

      let lastError: Error | undefined;

      for (const providerName of providersToTry) {
        if (signal?.aborted) {
          throw new Error("Search aborted");
        }

        const provider = createProvider(providerName);

        const dateInfo = effectiveDateRange ? ` [${DATE_RANGE_LABELS[effectiveDateRange] ?? effectiveDateRange}]` : "";
        onUpdate?.({
          content: [
            { type: "text", text: `Searching via ${providerName}: "${params.query}"${dateInfo}...` },
          ],
          details: {},
        });

        try {
          const result = await provider.search(
            params.query,
            effectiveNumResults,
            sessionId,
            signal ?? undefined,
            effectiveDateRange,
          );

          // Cache the raw (pre-truncation) result (Issue #2)
          const details = { provider: providerName, query: params.query, dateRange: effectiveDateRange ?? null };
          searchCache.set(providerName, params.query, effectiveDateRange, effectiveNumResults, result, details);

          return {
            content: [{ type: "text", text: truncateOutput(result) }],
            details,
          };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isAuth = err instanceof SearchAuthError;
          const isRateLimit = err instanceof SearchRateLimitError;
          const isServer = err instanceof SearchServerError;

          if (isAuth || isRateLimit || isServer) {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `⚠ ${lastError.message}. ${providersToTry.indexOf(providerName) < providersToTry.length - 1 ? "Trying next provider..." : ""}`,
                },
              ],
              details: {},
            });
            // Continue to next provider
            continue;
          }

          // For non-recoverable errors (config missing, empty results), also try fallback
          // unless it's the last provider
          if (providersToTry.indexOf(providerName) < providersToTry.length - 1) {
            onUpdate?.({
              content: [
                { type: "text", text: `⚠ ${lastError.message}. Trying next provider...` },
              ],
              details: {},
            });
            continue;
          }

          // Last provider failed
          throw lastError;
        }
      }

      // Should not reach here, but satisfy TypeScript
      throw lastError ?? new Error("No search providers available");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("websearch "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.dateRange) {
        text += theme.fg("dim", ` [${DATE_RANGE_LABELS[args.dateRange] ?? args.dateRange}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (isPartial) {
        const msg = text || "\u23f3 Searching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const details = result.details as { provider: string; query: string; dateRange?: string; cached?: boolean } | undefined;
      const lineCount = text.split("\n").length;

      let out = theme.fg("success", "\u2713");
      out += theme.fg("dim", ` ${lineCount} lines via ${details?.provider ?? "unknown"}${details?.cached ? " (cached)" : ""}`);
      if (details?.dateRange) {
        out += theme.fg("dim", ` [${DATE_RANGE_LABELS[details.dateRange as DateRange] ?? details.dateRange}]`);
      }

      if (expanded) {
        const lines = text.split("\n").slice(0, 20);
        for (const line of lines) {
          out += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          out += `\n${theme.fg("muted", `... ${lineCount - 20} more lines`)}`;
        }
      } else {
        out += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
      }

      return new Text(out, 0, 0);
    },
  });

  // --- webscreenshot (guarded public-page rendering via Latchshot) ---

  pi.registerTool({
    name: "webscreenshot",
    label: "Web Screenshot",
    description: [
      "Capture a public HTTP/HTTPS webpage as a PNG image attachment.",
      "Use for visual verification, UI review, or JavaScript-rendered pages when text fetch is insufficient.",
      "The hosted renderer blocks private networks and does not support cookies, login sessions, arbitrary scripts, selectors, CAPTCHA solving, or anti-bot bypass.",
    ].join("\n"),
    promptSnippet: "Capture a public webpage as an image",
    promptGuidelines: [
      "Use webscreenshot only when visual page evidence is materially useful.",
      "Capture only public pages the user is authorized to inspect.",
      "Do not use it for authenticated, private-network, or interaction-dependent pages.",
    ],
    parameters: WebScreenshotParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionFile() ?? "unsaved-session"
      takeScreenshotSlot(screenshotCounts, sessionId, MAX_SCREENSHOTS_PER_SESSION)

      const result = await capturePublicPage(params as ScreenshotParams, signal ?? undefined, onUpdate)
      return buildScreenshotToolResult(params as ScreenshotParams, result)
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("webscreenshot "))
      const url = args.url.length > 72 ? `${args.url.slice(0, 69)}...` : args.url
      text += theme.fg("accent", url)
      text += theme.fg("dim", ` ${args.width ?? 1280}×${args.height ?? 720}${args.fullPage ? " full page" : ""}`)
      return new Text(text, 0, 0)
    },

    renderResult(result, { isPartial }, theme, _context) {
      const content = result.content[0]
      const text = content?.type === "text" ? content.text : ""
      if (isPartial) return new Text(theme.fg("warning", text || "⏳ Capturing..."), 0, 0)
      const details = result.details as { bytes?: number; renderMs?: string } | undefined
      const suffix = details?.renderMs ? ` in ${details.renderMs} ms` : ""
      return new Text(theme.fg("success", `✓ Screenshot attached${suffix}`), 0, 0)
    },
  });

  // --- webfetch (same approach as opencode) ---

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description: [
      "Fetch and extract the text content of a web page or PDF URL.",
      "Returns the page content as markdown text.",
      "PDFs are automatically detected and their text is extracted with page markers.",
      "Use this tool to read specific web pages when you have a URL.",
    ].join("\n"),
    promptSnippet: "Fetch and extract text content from a URL",
    promptGuidelines: [
      "Use webfetch when you have a specific URL and need to read its content.",
      "For general web searching, use websearch instead.",
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const format = (params.format as "text" | "markdown" | "html" | undefined) ?? "markdown"

      onUpdate?.({
        content: [
          { type: "text", text: `Fetching ${params.url} (${format})...` },
        ],
        details: {},
      });

      const result = await fetchUrl(params.url, format, params.timeout, signal ?? undefined, onUpdate);

      if (result.isImage && result.imageMime && result.imageBase64) {
        return {
          content: [
            {
              type: "text",
              text: `Image fetched: ${params.url} (${result.contentType})`,
            },
          ],
          details: { url: params.url, format, contentType: result.contentType, isImage: true },
          attachments: [
            {
              type: "file" as const,
              mime: result.imageMime,
              url: `data:${result.imageMime};base64,${result.imageBase64}`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: truncateOutput(result.content) }],
        details: { url: params.url, format, contentType: result.contentType, metadata: result.metadata },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      const url = args.url.length > 80 ? `${args.url.slice(0, 77)}...` : args.url;
      text += theme.fg("accent", url);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (isPartial) {
        const msg = text || "\u23f3 Fetching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const details = result.details as { url: string; format: string; contentType: string; isImage?: boolean; metadata?: PageMetadata } | undefined;

      // Image result
      if (details?.isImage) {
        return new Text(theme.fg("success", "\u2713 Image fetched"), 0, 0);
      }

      const byteSize = Buffer.byteLength(text, "utf8");
      const lineCount = text.split("\n").length;

      let out = theme.fg("success", "\u2713");
      out += theme.fg("dim", ` ${formatSize(byteSize)} ${details?.format ?? "markdown"} (${lineCount} lines)`);

      // Show metadata summary if available
      const md = details?.metadata
      if (md && (md.title || md.author || md.publishedDate)) {
        const parts: string[] = []
        if (md.title) parts.push(md.title)
        if (md.author) parts.push(`by ${md.author}`)
        if (md.publishedDate) parts.push(md.publishedDate)
        out += `\n${theme.fg("accent", parts.join(" | "))}`
      }

      if (expanded) {
        const lines = text.split("\n").slice(0, 20);
        for (const line of lines) {
          out += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          out += `\n${theme.fg("muted", `... ${lineCount - 20} more lines`)}`;
        }
      } else {
        out += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
      }

      return new Text(out, 0, 0);
    },
  });
}
