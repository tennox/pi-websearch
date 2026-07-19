# pi-websearch

Web search and URL content fetching tools for [Pi](https://pi.dev) coding agent.

Adapted from [opencode](https://github.com/sst/opencode)'s [`websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/websearch.ts), [`mcp-websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/mcp-websearch.ts), and [`webfetch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts).

Registers three LLM-callable tools:

- **`websearch`** — search the web via one of 6 providers: [Brave](https://brave.com/search/api/), [Tavily](https://tavily.com), [Google](https://developers.google.com/custom-search), [SearXNG](https://searxng.org), [Exa](https://exa.ai), or [Parallel](https://parallel.ai)
- **`webfetch`** — direct HTTP fetch + HTML→markdown conversion
- **`webscreenshot`** — guarded public-page PNG capture through [Latchshot](https://latchshot.fly.dev/guides/screenshot-mcp-server.html)

## Install

```bash
pi install npm:@alfonzjanfrithz/pi-websearch
# or from GitHub
pi install git:github.com/alfonzjanfrithz/pi-websearch
```

## Configuration

### Search providers

| Variable | Description | Required |
|---|---|---|
| `BRAVE_API_KEY` | [Brave Search API](https://brave.com/search/api/) key | No — optional |
| `TAVILY_API_KEY` | [Tavily Search API](https://tavily.com) key | No — optional |
| `GOOGLE_API_KEY` | [Google Custom Search JSON API](https://developers.google.com/custom-search) key | No — optional (requires `GOOGLE_CX`) |
| `GOOGLE_CX` | Google Programmable Search Engine ID | No — optional (requires `GOOGLE_API_KEY`) |
| `SEARXNG_BASE_URL` | [SearXNG](https://searxng.org) instance URL (e.g. `https://searx.be`) | No — optional |
| `EXA_API_KEY` | [Exa](https://exa.ai) API key | No — works without |
| `PARALLEL_API_KEY` | [Parallel](https://parallel.ai) API key | No — works without |
| `PI_WEBSEARCH_PROVIDER` | Force a provider: `brave`, `tavily`, `google`, `searxng`, `exa`, or `parallel` | No — auto-selects |
| `PI_WEBSEARCH_DATE_RANGE` | Set to `0` to disable date range filtering entirely | No — enabled by default |
| `PI_WEBSEARCH_CACHE_TTL` | Cache time-to-live in seconds | No — default: `300` (5 minutes) |
| `PI_WEBSEARCH_CACHE_MAX` | Maximum number of cached search results | No — default: `100` |
| `PI_WEBSEARCH_CACHE` | Set to `off` to disable caching entirely | No — enabled by default |
| `LATCHSHOT_API_KEY` | Bearer key for `webscreenshot`; [100 successful renders renew each UTC month](https://latchshot.fly.dev/?intent=piwebsearch#trial) | Required only for `webscreenshot` |

Provider selection logic:

1. `PI_WEBSEARCH_PROVIDER` override → that provider
2. No override set → pick the highest-priority provider with configured credentials:
   - `BRAVE_API_KEY` → Brave
   - `TAVILY_API_KEY` → Tavily
   - `GOOGLE_API_KEY` + `GOOGLE_CX` → Google
   - `SEARXNG_BASE_URL` → SearXNG
3. No keys configured → deterministic hash of session ID → 50/50 split between Exa and Parallel

**Fallback** — If a provider fails (invalid key, rate limit, timeout, server error), the tool automatically tries the next available provider in the priority chain.

### Web fetch

No API keys needed. Fetches URLs directly, converts HTML to markdown using `turndown`. No third-party services.

## Tools

### `websearch`

Search the web and return relevant content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query |
| `numResults` | number | no | Number of results (default: 8) |
| `dateRange` | `"last_day" \| "last_week" \| "last_month" \| "last_3m" \| "last_6m" \| "last_9m" \| "last_year" \| "ytd"` | no | Filter results by recency |

**Date range mapping** — Each provider maps `dateRange` to its native API parameter:

| `dateRange` | Label | Brave | Tavily | Google | SearXNG | Exa | Parallel |
|---|---|---|---|---|---|---|---|
| `last_day` | 24h | `freshness=pd` | `time_range=day` | `dateRestrict=d1` | `time_range=day` | ISO date (1 day ago) | — |
| `last_week` | 7d | `freshness=pw` | `time_range=week` | `dateRestrict=w1` | `time_range=week` | ISO date (7 days ago) | — |
| `last_month` | 30d | `freshness=pm` | `time_range=month` | `dateRestrict=m1` | `time_range=month` | ISO date (30 days ago) | — |
| `last_3m` | 3m | `freshness=<custom>` ⚠️ | `start_date=<ISO>` | `dateRestrict=m3` | `time_range=month` ⚠️ | ISO date (90 days ago) | — |
| `last_6m` | 6m | `freshness=<custom>` ⚠️ | `start_date=<ISO>` | `dateRestrict=m6` | `time_range=year` ⚠️ | ISO date (180 days ago) | — |
| `last_9m` | 9m | `freshness=<custom>` ⚠️ | `start_date=<ISO>` | `dateRestrict=m9` | `time_range=year` ⚠️ | ISO date (270 days ago) | — |
| `last_year` | 1y | `freshness=py` | `time_range=year` | `dateRestrict=y1` | `time_range=year` | ISO date (365 days ago) | — |
| `ytd` | YTD | `freshness=<custom>` ⚠️ | `start_date=<ISO>` | `dateRestrict=d<N>` ⚠️ | `time_range=year` ⚠️ | ISO date (Jan 1) | — |

⚠️ = approximate mapping (see notes below)

**Provider-specific date range notes:**

- **Brave**: Intermediate ranges use custom date ranges (`YYYY-MM-DDtoYYYY-MM-DD`). YTD computes from Jan 1 of the current year.
- **Tavily**: Intermediate ranges and YTD use `start_date` (ISO date) instead of `time_range` presets, which provides exact dates.
- **Google**: YTD is approximated as `d<N>` (days since Jan 1). All other ranges use native `d[N]`/`w[N]`/`m[N]`/`y[N]` units.
- **SearXNG**: Only supports 4 presets (`day`/`week`/`month`/`year`). `last_3m` falls back to `month`, `last_6m`/`last_9m`/`ytd` fall back to `year`.
- **Exa**: All ranges are computed as ISO `startPublishedDate` offsets — fully flexible.
- **Parallel**: Does not support date filtering. The parameter is silently ignored.

Set `PI_WEBSEARCH_DATE_RANGE=0` to completely disable the `dateRange` parameter (it will be stripped from all requests regardless of what the LLM passes).

### `webfetch`

Fetch a URL and extract its content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | URL to fetch |
| `format` | `"text"` \| `"markdown"` \| `"html"` | no | Output format (default: `"markdown"`) |
| `timeout` | number | no | Timeout in seconds (max 120) |

### `webscreenshot`

Capture one public webpage as an inline PNG attachment. The extension sends the key only to the fixed HTTPS Latchshot endpoint and never places it in the URL, tool result, or logs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Public HTTP/HTTPS page to capture |
| `width` | number | no | Viewport width, 320–2560 (default: 1280) |
| `height` | number | no | Viewport height, 240–1440 (default: 720) |
| `fullPage` | boolean | no | Capture the full scrollable page (default: false) |
| `timeout` | number | no | Browser timeout in seconds, 3–30 (default: 30) |

The tool is limited to 10 capture attempts per Pi session. Only successful renders consume Latchshot quota. It supports public pages only: private/loopback/special-use networks, cookies, login sessions, arbitrary scripts, CSS-selector crops, CAPTCHA solving, proxy rotation, and anti-bot bypass are not supported. The user remains responsible for permission to capture the target page.

**Metadata extraction** — When fetching HTML pages, `webfetch` automatically extracts structured metadata and includes it in the result:

| Field | Source |
|---|---|
| `title` | OpenGraph (`og:title`) → JSON-LD `headline` → `<title>` → meta description |
| `description` | OpenGraph (`og:description`) → JSON-LD `description` → HTML meta description |
| `author` | OpenGraph (`og:article:author`) → JSON-LD `author`/`creator` → HTML meta author |
| `publishedDate` | OpenGraph (`og:article:published_time`) → JSON-LD `datePublished` → HTML meta date |
| `canonicalUrl` | OpenGraph (`og:url`) → `<link rel="canonical">` |
| `image` | OpenGraph (`og:image`) → JSON-LD `image` |
| `siteName` | OpenGraph (`og:site_name`) |
| `type` | OpenGraph (`og:type`) → JSON-LD `@type` |

## Features

- 6 search providers with automatic fallback on failure
- 8 date/recency filters via `dateRange` parameter (last_day, last_week, last_month, last_3m, last_6m, last_9m, last_year, ytd) with provider-specific mapping
- Disable date range filtering via `PI_WEBSEARCH_DATE_RANGE=0`
- Direct HTTP fetch with browser-like User-Agent
- HTML→markdown via `turndown`, text extraction via `htmlparser2`
- Cloudflare bot detection retry (honest UA fallback)
- Image support (returned as base64 attachments)
- Public-page screenshots returned as base64 PNG attachments
- Output truncation (50KB / 2000 lines, overflow saved to temp file)
- Automatic page metadata extraction (OpenGraph, JSON-LD structured data, HTML meta tags)
- Search result caching with TTL-based expiry and LRU eviction (Issue #2)
  - In-memory cache keyed by provider + query + dateRange + numResults
  - Default 5-minute TTL, configurable via `PI_WEBSEARCH_CACHE_TTL`
  - Default 100-entry max with LRU eviction, configurable via `PI_WEBSEARCH_CACHE_MAX`
  - Disable entirely with `PI_WEBSEARCH_CACHE=off`
  - Cache hits shown in TUI with "(cached)" indicator
  - Only successful results are cached; errors always fall through to the provider

## Testing

**Note:** Public SearXNG instances often disable the JSON API or rate-limit it. For best results, [self-host SearXNG](https://docs.searxng.org/admin/installation.html) and enable `json` in `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## License

MIT
