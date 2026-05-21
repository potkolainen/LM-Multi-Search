# multi-search

Online web search for local LLMs. Ships in **two forms** from a single codebase:

- 🧩 An **LM Studio plugin** with a per-chat config panel (toggle search on/off, pick mode, tick engines).
- 🔌 A **standalone MCP server** you can drop into any MCP host's `mcp.json` (LM Studio, Claude Desktop, etc.).

Bundles **14 search engines** and a **parallel multi-engine** mode that fans out one query, interleaves results round-robin, and dedupes by URL. Also exposes a dependency-free **page reader** so the model can fetch and read result URLs.

No browser, no Playwright, no API keys — just Node 22's built-in `fetch` and a small HTML→text extractor.

---

## Tools exposed to the model

| Tool | What it does |
|---|---|
| `list_search_engines` | Returns available engine ids and the current mode/defaults. |
| `web_search` | Runs a search, **filters junk** (empty titles, redirect wrappers), **dedupes** by normalized URL, **ranks** by host trust + title/snippet query-overlap, returns the **top K** with a `score` (0–1) and `host` per result. |
| `fetch_page` | Fetches one URL and returns its extracted main text. If you pass `query`, long pages are truncated **query-aware** — paragraphs containing query terms are kept instead of just the first N chars. |
| `web_search_full` | One-stop: `web_search` + concurrently fetches the top *N* result pages with query-aware extraction. Use this **instead of** `web_search` + multiple `fetch_page` calls. |
| `get_weather` | Current conditions + 3-day forecast for any city / ZIP / airport code. Backed by [wttr.in](https://wttr.in) (no API key). Use this for weather questions instead of `web_search` — search snippets almost never contain actual temperatures. |

All search responses include `returned`, `dropped_as_noise`, `from_cache`, and `per_engine_counts` for transparency. When the top result score is very low (< 0.35) or zero results survive filtering, an additional `note` field tells the model to rephrase or pick a more specific tool.

## Result ranking & noise reduction

Every `web_search` / `web_search_full` response is post-processed:

1. **Junk drop** — empty titles, search-engine redirect wrappers (`duckduckgo.com/l/?`, `google.com/url?`, etc.), non-http URLs.
2. **URL normalization** — lowercase host, strip `www.`, strip `#fragment`, drop `utm_*` / `fbclid` / `ref` / `source` / `gclid` tracking params, strip trailing `/`.
3. **Dedupe** — by normalized URL, keeping the higher-scoring instance.
4. **Score** = `0.45 · titleQueryOverlap + 0.30 · hostTrust + 0.20 · snippetQueryOverlap + 0.05 · snippetLengthBonus`.
   - **Host trust** is a built-in map: wikipedia/arxiv ≈ 0.9, .gov 0.85, .edu / github / stackoverflow ≈ 0.8, reddit ≈ 0.55, pinterest ≈ 0.2, unknown 0.5.
5. **Top-K** — sorted by score, sliced to `topK` (default 8).
6. **Snippet trim** — cap each snippet to `snippetMaxChars` (default 240).

Turn on `includeScoreBreakdown` (per-chat setting / `MULTI_SEARCH_SCORE_BREAKDOWN=1`) to see per-result `{ host_trust, title_overlap, snippet_overlap, snippet_length_bonus }`.

## In-process cache

A tiny LRU+TTL cache (100 search entries, 50 `web_search_full` entries) deduplicates repeat calls within the same plugin session. Default TTL is 5 minutes. Set `cacheTtlSec` to 0 (or `MULTI_SEARCH_CACHE_TTL=0`) to disable. Responses include `from_cache: true` when served from cache.

## Supported engines (14)

`duckduckgo`, `brave`, `bing`, `qwant`, `ecosia`, `startpage`, `metager`,
`wikipedia`, `arxiv`, `reddit`, `stackoverflow`, `github`, `google-scholar`,
`devdocs`

> Most reliable: `duckduckgo`, `brave`, `bing`, `wikipedia`, `arxiv`, `reddit`, `stackoverflow`, `github`.
> Scraped engines (`ecosia`, `startpage`, etc.) can occasionally be rate-limited — the multi-engine mode tolerates this and just keeps whatever returned successfully.

---

## Install

```bash
git clone <this-repo>
cd "Multi search"
npm install
npm run build
```

Requires **Node 22+** (uses the built-in global `fetch` / `AbortController`).

---

## Use as a standalone MCP server

After `npm run build`, point your MCP host at `dist/mcp.js`. Example `mcp.json` (LM Studio, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "multi-search": {
      "command": "node",
      "args": ["/absolute/path/to/Multi search/dist/mcp.js"],
      "cwd": "/absolute/path/to/Multi search",
      "env": {
        "MULTI_SEARCH_MODE": "multi",
        "MULTI_SEARCH_MULTI_ENGINES": "duckduckgo,brave,bing,wikipedia",
        "MULTI_SEARCH_FETCH_TOP_N": "3",
        "MULTI_SEARCH_MAX_CONTENT": "10000"
      }
    }
  }
}
```

### Environment variables

MCP has no settings UI, so the standalone server is configured purely via env vars:

| Variable | Default | Range | Purpose |
|---|---|---|---|
| `MULTI_SEARCH_MODE` | `multi` | `single` \| `multi` | Search strategy. |
| `MULTI_SEARCH_SINGLE_ENGINE` | `duckduckgo` | any engine id | Engine used in single mode. |
| `MULTI_SEARCH_MULTI_ENGINES` | `duckduckgo,brave,bing,wikipedia` | comma list | Engines queried in multi mode. |
| `MULTI_SEARCH_MAX_RESULTS` | `5` | 1–20 | Raw results per engine cap. |
| `MULTI_SEARCH_TOP_K` | `8` | 1–25 | Final top-K returned after ranking. |
| `MULTI_SEARCH_SNIPPET_MAX` | `240` | 80–2000 | Snippet length cap (chars). |
| `MULTI_SEARCH_CACHE_TTL` | `300` | 0–3600 sec | Search-cache TTL. `0` = disabled. |
| `MULTI_SEARCH_SCORE_BREAKDOWN` | `0` | `0`/`1` | Include per-result scoring breakdown for transparency. |
| `MULTI_SEARCH_FETCH_TOP_N` | `3` | 0–10 | Pages fetched by `web_search_full`. |
| `MULTI_SEARCH_FETCH_CONCURRENCY` | `3` | 1–8 | Parallel page fetches. |
| `MULTI_SEARCH_REQUEST_TIMEOUT` | `15000` | 1000–60000 ms | Per-engine HTTP timeout. |
| `MULTI_SEARCH_PAGE_TIMEOUT` | `10000` | 1000–60000 ms | Page-fetch timeout. |
| `MULTI_SEARCH_MAX_CONTENT` | `10000` | 500–200000 chars | Extracted page text cap. |
| `MULTI_SEARCH_USER_AGENT` | Chrome 120 UA | string | User-Agent for all HTTP requests. |

### Quick smoke test

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/mcp.js
```

Should print two JSON-RPC responses on stdout and `multi-search MCP server ready on stdio` on stderr.

---

## Use as an LM Studio plugin

```bash
npm install
lms dev          # hot-reload while developing
# or
lms push         # install into LM Studio
```

When loaded as a plugin you get a **per-chat config panel** with these fields:

| Field | Default | Purpose |
|---|---|---|
| `searchEnabled` | ✅ on | Kill-switch. When off, no tools are exposed to the model at all. |
| `mode` | `single` | `single` or `multi`. Only one `web_search` tool is exposed at a time, matching this mode. |
| `singleEngine` | `duckduckgo` | Engine used in single mode. |
| `maxResultsPerEngine` | `5` | Raw results-per-engine cap (1–20). |
| `topK` | `8` | Final number of best-scoring results returned after ranking (1–25). |
| `snippetMaxChars` | `240` | Snippet length cap to save context (80–2000). |
| `cacheTtlSec` | `300` | Search-cache TTL in seconds. `0` disables caching. |
| `includeScoreBreakdown` | off | Attach per-result scoring breakdown for transparency / debugging. |
| `fetchTopN` | `3` | Pages fetched by `web_search_full` (0–10). |
| `fetchConcurrency` | `3` | Parallel page fetches (1–8). |
| `Multi: <Engine>` × 14 | duckduckgo / brave / bing / wikipedia | One checkbox per engine — pick which to include in multi mode. |

And global plugin settings (apply across all chats):

| Field | Default | Purpose |
|---|---|---|
| `requestTimeoutMs` | `15000` | Per-engine HTTP timeout. |
| `pageFetchTimeoutMs` | `10000` | Timeout for `fetch_page` / `web_search_full` page loads. |
| `maxContentLength` | `10000` | Hard cap on extracted page text length. |
| `userAgent` | Chrome 120 UA | User-Agent header. |

---

## How multi-engine mode works

1. Fan out the same query to every checked engine in parallel (`Promise.all`).
2. Round-robin interleave: take the 1st result from each engine, then 2nd from each, then 3rd…
3. Dedupe by URL (ignoring `?query` and `#fragment`).
4. Tag each result with its `source` engine so the model knows where it came from.
5. Any engine that errors or times out returns `[]` — the rest still come through.

This gives broader topical coverage than a single engine and degrades gracefully when one engine breaks.

## Page extraction

`fetch_page` and `web_search_full` use a small dependency-free extractor that:

- strips `<script>`, `<style>`, `<noscript>`, `<svg>`, `<iframe>`, `<form>`, `<nav>`, `<aside>`, `<footer>`, `<header>`,
- prefers `<article>` → `<main>` → largest `<div>` by visible text,
- decodes HTML entities,
- converts block-level tags to newlines (so `<p>foo</p><p>bar</p>` doesn't collapse to `foobar`),
- collapses whitespace,
- truncates to `maxContentLength`.

It is **not** a full Readability re-implementation — for pathological pages (heavy SPA, lazy-loaded content, Cloudflare challenges) it will return less than a browser-based scraper would. The trade-off is zero native deps and instant cold start.

---

## Project layout

```
src/
  engines.ts          # 14 search engines + shared helpers (fetch with timeout, etc.)
  extract.ts          # HTML → main-text extractor (with query-aware truncation)
  ranking.ts          # URL normalization, dedupe, host-trust scoring, top-K filter
  cache.ts            # Tiny in-process LRU + TTL cache
  weather.ts          # wttr.in client for the get_weather tool
  configSchematics.ts # LM Studio plugin per-chat + global config schema
  toolsProvider.ts    # LM Studio plugin tool registration
  index.ts            # LM Studio plugin entry point
  mcp.ts              # Standalone MCP stdio server entry point
```

Both distributions share `engines.ts` and `extract.ts`, so any new engine becomes available in both modes at once.

## Scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run dev` | `lms dev` — run as a hot-reloading LM Studio plugin. |
| `npm run push` | `lms push` — install the plugin into LM Studio. |
| `npm run start:mcp` | `node dist/mcp.js` — run the MCP server on stdio. |

## Adding a new engine

1. Implement an `EngineFn` in [src/engines.ts](src/engines.ts):
   ```ts
   async function myEngine(query: string, opts: EngineOptions): Promise<SearchResult[]> { … }
   ```
2. Register it in the `ENGINES` map.
3. Add a pretty label to `ENGINE_LABELS` in [src/configSchematics.ts](src/configSchematics.ts).
4. (Optional) Add it to `DEFAULT_MULTI` if you want it ticked by default.
5. `npm run build`. It now appears in both the plugin's checkbox list and the MCP server's `list_search_engines` output.

## License

MIT
