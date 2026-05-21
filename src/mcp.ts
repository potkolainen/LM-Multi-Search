#!/usr/bin/env node
/**
 * Standalone MCP server build of multi-search.
 * Speaks the Model Context Protocol over stdio so it can be wired into
 * LM Studio's mcp.json (or any other MCP host) without `lms dev`.
 *
 * Config is read from environment variables since MCP has no settings UI.
 * See README.md for the full env-var table.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_ENGINE_IDS,
  ENGINES,
  EngineOptions,
  SearchResult,
  isEngine,
} from "./engines";
import { fetchAndExtract, fetchAndExtractMany, FetchPageOptions } from "./extract";
import { rankAndFilter, ScoredResult } from "./ranking";
import { TtlLruCache } from "./cache";
import { getWeather } from "./weather";

// ---------- env-driven config ----------

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}
function envInt(key: string, fallback: number, min: number, max: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const CFG = {
  mode: (envStr("MULTI_SEARCH_MODE", "multi") === "single" ? "single" : "multi") as
    | "single"
    | "multi",
  singleEngine: envStr("MULTI_SEARCH_SINGLE_ENGINE", "duckduckgo").toLowerCase(),
  multiEngines: envStr("MULTI_SEARCH_MULTI_ENGINES", "duckduckgo,brave,bing,wikipedia")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
  maxResults: envInt("MULTI_SEARCH_MAX_RESULTS", 5, 1, 20),
  topK: envInt("MULTI_SEARCH_TOP_K", 8, 1, 25),
  snippetMaxChars: envInt("MULTI_SEARCH_SNIPPET_MAX", 240, 80, 2000),
  cacheTtlMs: envInt("MULTI_SEARCH_CACHE_TTL", 300, 0, 3600) * 1000,
  includeScoreBreakdown: envBool("MULTI_SEARCH_SCORE_BREAKDOWN", false),
  fetchTopN: envInt("MULTI_SEARCH_FETCH_TOP_N", 3, 0, 10),
  fetchConcurrency: envInt("MULTI_SEARCH_FETCH_CONCURRENCY", 3, 1, 8),
  requestTimeoutMs: envInt("MULTI_SEARCH_REQUEST_TIMEOUT", 15000, 1000, 60000),
  pageTimeoutMs: envInt("MULTI_SEARCH_PAGE_TIMEOUT", 10000, 1000, 60000),
  maxContentLength: envInt("MULTI_SEARCH_MAX_CONTENT", 10000, 500, 200000),
  userAgent: envStr(
    "MULTI_SEARCH_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ),
};

const searchCache = new TtlLruCache<SearchResult[]>(100, CFG.cacheTtlMs || 1);
const fullSearchCache = new TtlLruCache<any>(50, CFG.cacheTtlMs || 1);

function engineOpts(maxResults?: number): EngineOptions {
  return {
    userAgent: CFG.userAgent,
    timeoutMs: CFG.requestTimeoutMs,
    maxResults: Math.max(1, Math.min(20, maxResults ?? CFG.maxResults)),
  };
}
function fetchOpts(query?: string, maxContentLength?: number): FetchPageOptions {
  return {
    userAgent: CFG.userAgent,
    timeoutMs: CFG.pageTimeoutMs,
    maxContentLength: maxContentLength ?? CFG.maxContentLength,
    query,
  };
}

const LOW_RELEVANCE_THRESHOLD = 0.35;
function relevanceNote(ranked: ScoredResult[], query: string): string | undefined {
  if (ranked.length === 0) {
    return `No results passed the noise filter for "${query}". Try rephrasing or a different engine. If this is a weather query, use get_weather instead.`;
  }
  const top = ranked[0].score;
  if (top < LOW_RELEVANCE_THRESHOLD) {
    return `Top result score is low (${top.toFixed(2)} < ${LOW_RELEVANCE_THRESHOLD}). Snippets may not actually answer "${query}" — consider rephrasing, switching engines, or using a specialized tool (e.g. get_weather for weather).`;
  }
  return undefined;
}

// ---------- shared search runner ----------

interface RunOut {
  enginesUsed: string[];
  unknownEngines: string[];
  perEngineCounts: Record<string, number>;
  raw: SearchResult[];
  fromCache: boolean;
}

async function runSearch(args: {
  query: string;
  engine?: string;
  engines?: string[];
  maxPerEngine?: number;
}): Promise<RunOut> {
  const opts = engineOpts(args.maxPerEngine);

  if (CFG.mode === "single") {
    const id = (args.engine ?? CFG.singleEngine).toLowerCase();
    if (!isEngine(id)) {
      return {
        enginesUsed: [],
        unknownEngines: [id],
        perEngineCounts: {},
        raw: [],
        fromCache: false,
      };
    }
    const cacheKey = `s|${id}|${opts.maxResults}|${args.query}`;
    if (CFG.cacheTtlMs > 0) {
      const hit = searchCache.get(cacheKey);
      if (hit) {
        return {
          enginesUsed: [id],
          unknownEngines: [],
          perEngineCounts: { [id]: hit.length },
          raw: hit,
          fromCache: true,
        };
      }
    }
    let results: SearchResult[] = [];
    try {
      results = await ENGINES[id](args.query, opts);
    } catch {
      results = [];
    }
    if (CFG.cacheTtlMs > 0) searchCache.set(cacheKey, results);
    return {
      enginesUsed: [id],
      unknownEngines: [],
      perEngineCounts: { [id]: results.length },
      raw: results,
      fromCache: false,
    };
  }

  const requested =
    args.engines && args.engines.length > 0
      ? args.engines.map((e) => e.toLowerCase())
      : CFG.multiEngines;
  const unknown = requested.filter((id) => !isEngine(id));
  const valid = requested.filter(isEngine);
  if (valid.length === 0) {
    return {
      enginesUsed: [],
      unknownEngines: unknown,
      perEngineCounts: {},
      raw: [],
      fromCache: false,
    };
  }

  const cacheKey = `m|${valid.slice().sort().join(",")}|${opts.maxResults}|${args.query}`;
  if (CFG.cacheTtlMs > 0) {
    const hit = searchCache.get(cacheKey);
    if (hit) {
      return {
        enginesUsed: valid,
        unknownEngines: unknown,
        perEngineCounts: valid.reduce<Record<string, number>>((a, id) => {
          a[id] = 0;
          return a;
        }, {}),
        raw: hit,
        fromCache: true,
      };
    }
  }

  const perEngine = await Promise.all(
    valid.map(async (id) => {
      try {
        return { id, results: await ENGINES[id](args.query, opts) };
      } catch {
        return { id, results: [] as SearchResult[] };
      }
    }),
  );

  const maxLen = Math.max(...perEngine.map((p) => p.results.length), 0);
  const interleaved: SearchResult[] = [];
  for (let i = 0; i < maxLen; i++) {
    for (const p of perEngine) {
      const r = p.results[i];
      if (r) interleaved.push(r);
    }
  }
  if (CFG.cacheTtlMs > 0) searchCache.set(cacheKey, interleaved);

  return {
    enginesUsed: valid,
    unknownEngines: unknown,
    perEngineCounts: Object.fromEntries(perEngine.map((p) => [p.id, p.results.length])),
    raw: interleaved,
    fromCache: false,
  };
}

// ---------- tool definitions ----------

const ENGINE_HINT =
  "Available engines: duckduckgo, brave, bing, qwant, ecosia, startpage, " +
  "metager, wikipedia, arxiv, reddit, stackoverflow, github, google-scholar, " +
  "devdocs. Pick wikipedia for encyclopedic summaries, arxiv for papers, " +
  "github for code, stackoverflow for programming Q&A, reddit for discussion.";

const TOOLS = [
  {
    name: "list_search_engines",
    description:
      "Returns supported engine ids and the server's current default mode/engines. You usually don't need to call this — engine ids: " +
      "duckduckgo, brave, bing, qwant, ecosia, startpage, metager, wikipedia, arxiv, reddit, stackoverflow, github, google-scholar, devdocs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "web_search",
    description:
      "Searches the web and returns top-K best results after de-duplication and host-trust ranking. " +
      "Each result has title, snippet (trimmed), url, source, host, score (0–1). " +
      "If you need page CONTENT, call `web_search_full` instead of doing `web_search` + multiple `fetch_page` calls. " +
      "When the user asks for a specific site (Wikipedia, GitHub, arXiv, Reddit), pass that engine id. " +
      "Don't retry the same query verbatim — change wording or engines if results are poor. " +
      ENGINE_HINT,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        engine: {
          type: "string",
          description: "Single-mode engine id (e.g. 'wikipedia').",
        },
        engines: {
          type: "array",
          items: { type: "string" },
          description:
            "Multi-mode engine list override. Use ['wikipedia'] etc. to restrict to one source.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "How many ranked results to return.",
        },
        max_results_per_engine: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Raw results requested per engine before ranking.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetches a single URL and returns its extracted main text (title + body, ads/nav stripped). " +
      "Pass `query` if you have one — when the page is too long the extractor keeps paragraphs containing query terms instead of just the first N chars. " +
      "If you want to search AND read top results, use `web_search_full` — it does both in one call.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http(s) URL." },
        query: {
          type: "string",
          description:
            "Optional query terms. When set and the page exceeds the length cap, query-relevant paragraphs are kept.",
        },
        max_content_length: {
          type: "integer",
          minimum: 500,
          maximum: 200000,
          description: "Hard cap on returned content length.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search_full",
    description:
      "ONE-STOP tool: searches the web AND concurrently fetches the top N result pages, returning each result with extracted main text in `page.content`. " +
      "Page extraction is query-aware — for long pages it keeps paragraphs containing your query terms. " +
      "USE THIS INSTEAD of doing web_search followed by multiple fetch_page calls. " +
      "Keep fetch_top_n small (1–5). Pass engines: ['wikipedia'] etc. to restrict to one source. " +
      ENGINE_HINT,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        engine: { type: "string", description: "Single-mode engine override." },
        engines: {
          type: "array",
          items: { type: "string" },
          description: "Multi-mode engine list override (e.g. ['wikipedia']).",
        },
        fetch_top_n: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          description: "How many of the top-ranked results to fetch full content for.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "How many ranked results to return overall.",
        },
        max_results_per_engine: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Raw results requested per engine before ranking.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_weather",
    description:
      "Returns CURRENT weather conditions and a 3-day forecast for a city or location. " +
      "USE THIS for any weather question — do NOT use web_search for weather, because search snippets rarely contain actual temperatures. " +
      "Pass any human location string: 'Oulu', 'São Paulo, Brazil', 'New York', '94103', 'JFK', etc. Data source: wttr.in.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City, region, ZIP, or airport code. e.g. 'Oulu' or 'São Paulo, Brazil'.",
        },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "Temperature/wind units. Default: metric (°C, km/h).",
        },
        lang: {
          type: "string",
          description: "ISO language code for the weather description (e.g. 'en', 'fi', 'pt').",
        },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
];

// ---------- MCP server ----------

const server = new Server(
  { name: "multi-search", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    let result: unknown;
    switch (name) {
      case "list_search_engines":
        result = {
          engines: ALL_ENGINE_IDS,
          mode: CFG.mode,
          single_engine: CFG.singleEngine,
          multi_engines: CFG.multiEngines,
          hint: "Prefer web_search_full over web_search + fetch_page when you need page content. For Wikipedia summaries pass engine: 'wikipedia'.",
        };
        break;

      case "web_search": {
        const query = String(args.query ?? "");
        const r = await runSearch({
          query,
          engine: args.engine,
          engines: args.engines,
          maxPerEngine: args.max_results_per_engine,
        });
        if (r.enginesUsed.length === 0) {
          result = {
            error:
              CFG.mode === "single"
                ? `Unknown engine: ${r.unknownEngines[0] ?? args.engine}`
                : "No engines available. Pass engines: [...] explicitly.",
            available: ALL_ENGINE_IDS,
          };
          break;
        }
        const ranked = rankAndFilter(r.raw, {
          query,
          topK: args.max_results ?? CFG.topK,
          snippetMaxChars: CFG.snippetMaxChars,
          includeScoreBreakdown: CFG.includeScoreBreakdown,
        });
        const note = relevanceNote(ranked, query);
        result = {
          query,
          mode: CFG.mode,
          engines_used: r.enginesUsed,
          unknown_engines: r.unknownEngines,
          per_engine_counts: r.perEngineCounts,
          from_cache: r.fromCache,
          returned: ranked.length,
          dropped_as_noise: r.raw.length - ranked.length,
          results: ranked,
          ...(note ? { note } : {}),
        };
        break;
      }

      case "fetch_page":
        result = await fetchAndExtract(
          String(args.url),
          fetchOpts(args.query, args.max_content_length),
        );
        break;

      case "get_weather":
        result = await getWeather(String(args.location), {
          userAgent: CFG.userAgent,
          timeoutMs: CFG.requestTimeoutMs,
          units: args.units,
          lang: args.lang,
        });
        break;

      case "web_search_full": {
        const query = String(args.query ?? "");
        const fullKey = `f|${CFG.mode}|${args.engine ?? ""}|${(args.engines ?? []).slice().sort().join(",")}|${args.fetch_top_n ?? ""}|${args.max_results ?? ""}|${args.max_results_per_engine ?? ""}|${query}`;
        if (CFG.cacheTtlMs > 0) {
          const hit = fullSearchCache.get(fullKey);
          if (hit) {
            result = { ...hit, from_cache: true };
            break;
          }
        }
        const r = await runSearch({
          query,
          engine: args.engine,
          engines: args.engines,
          maxPerEngine: args.max_results_per_engine,
        });
        if (r.enginesUsed.length === 0) {
          result = {
            error:
              CFG.mode === "single"
                ? `Unknown engine: ${r.unknownEngines[0] ?? args.engine}`
                : "No engines available. Pass engines: [...] explicitly.",
            available: ALL_ENGINE_IDS,
          };
          break;
        }
        const ranked: ScoredResult[] = rankAndFilter(r.raw, {
          query,
          topK: args.max_results ?? CFG.topK,
          snippetMaxChars: CFG.snippetMaxChars,
          includeScoreBreakdown: CFG.includeScoreBreakdown,
        });
        const topN = Math.max(0, Math.min(10, args.fetch_top_n ?? CFG.fetchTopN));
        const urls = ranked.slice(0, topN).map((x) => x.url);
        const pages =
          topN > 0
            ? await fetchAndExtractMany(urls, fetchOpts(query), CFG.fetchConcurrency)
            : [];
        const byUrl = new Map(pages.map((p) => [p.url, p]));
        const note = relevanceNote(ranked, query);
        const out = {
          query,
          mode: CFG.mode,
          engines_used: r.enginesUsed,
          unknown_engines: r.unknownEngines,
          per_engine_counts: r.perEngineCounts,
          returned: ranked.length,
          dropped_as_noise: r.raw.length - ranked.length,
          fetched: pages.length,
          results: ranked.map((res, i) => ({
            ...res,
            page: i < topN ? byUrl.get(res.url) ?? null : null,
          })),
          from_cache: false,
          ...(note ? { note } : {}),
        };
        if (CFG.cacheTtlMs > 0) fullSearchCache.set(fullKey, out);
        result = out;
        break;
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("multi-search MCP server ready on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
