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
| `web_search` | Runs a search. In **single** mode hits one engine; in **multi** mode queries several in parallel and returns interleaved + deduped results. |
| `fetch_page` | Fetches one URL and returns its extracted main text (title + body, nav/ads/scripts stripped). |
| `web_search_full` | `web_search` + concurrently fetches the top *N* result pages, attaching the extracted content to each result. |

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
| `MULTI_SEARCH_MAX_RESULTS` | `5` | 1–20 | Results per engine cap. |
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
| `maxResultsPerEngine` | `5` | Results-per-engine cap (1–20). |
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
  engines.ts          # 14 search engines + shared helpers (fetch with timeout, dedupe, etc.)
  extract.ts          # HTML → main-text extractor for fetch_page / web_search_full
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
