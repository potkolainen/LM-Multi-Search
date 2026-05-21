#!/usr/bin/env node
/**
 * Standalone MCP server build of multi-search.
 * Speaks the Model Context Protocol over stdio so it can be wired into
 * LM Studio's mcp.json (or any other MCP host) without `lms dev`.
 *
 * Config is read from environment variables since MCP has no settings UI:
 *   MULTI_SEARCH_MODE              "single" | "multi"   (default: "multi")
 *   MULTI_SEARCH_SINGLE_ENGINE     engine id            (default: "duckduckgo")
 *   MULTI_SEARCH_MULTI_ENGINES     comma list           (default: "duckduckgo,brave,bing,wikipedia")
 *   MULTI_SEARCH_MAX_RESULTS       1-20                 (default: 5)
 *   MULTI_SEARCH_FETCH_TOP_N       0-10                 (default: 3)
 *   MULTI_SEARCH_FETCH_CONCURRENCY 1-8                  (default: 3)
 *   MULTI_SEARCH_REQUEST_TIMEOUT   ms                   (default: 15000)
 *   MULTI_SEARCH_PAGE_TIMEOUT      ms                   (default: 10000)
 *   MULTI_SEARCH_MAX_CONTENT       chars                (default: 10000)
 *   MULTI_SEARCH_USER_AGENT        UA string            (default: Chrome 120 UA)
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

function engineOpts(maxResults?: number): EngineOptions {
  return {
    userAgent: CFG.userAgent,
    timeoutMs: CFG.requestTimeoutMs,
    maxResults: Math.max(1, Math.min(20, maxResults ?? CFG.maxResults)),
  };
}
function fetchOpts(maxContentLength?: number): FetchPageOptions {
  return {
    userAgent: CFG.userAgent,
    timeoutMs: CFG.pageTimeoutMs,
    maxContentLength: maxContentLength ?? CFG.maxContentLength,
  };
}

// ---------- tool definitions ----------

const TOOLS = [
  {
    name: "list_search_engines",
    description:
      "Returns the list of available search engine ids and the server's current default mode/engines.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "web_search",
    description:
      "Searches the web. In single mode uses one engine; in multi mode queries several engines in parallel and interleaves+dedupes results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        engine: {
          type: "string",
          description:
            "Single mode: which engine to use (overrides MULTI_SEARCH_SINGLE_ENGINE).",
        },
        engines: {
          type: "array",
          items: { type: "string" },
          description: "Multi mode: override list of engine ids.",
        },
        max_results_per_engine: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Results per engine cap.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetches a single URL and returns its extracted main text content (title + body, ads/nav stripped).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http(s) URL." },
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
      "Searches the web and concurrently fetches the top N result pages, returning extracted page content alongside each result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        engine: { type: "string", description: "Single-mode engine override." },
        engines: {
          type: "array",
          items: { type: "string" },
          description: "Multi-mode engine list override.",
        },
        fetch_top_n: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          description: "How many results to fetch full content for.",
        },
        max_results_per_engine: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Results per engine before fetching.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

// ---------- search helpers ----------

async function runSearch(args: {
  query: string;
  engine?: string;
  engines?: string[];
  max_results_per_engine?: number;
}): Promise<{
  mode: "single" | "multi";
  enginesUsed: string[];
  unknownEngines: string[];
  perEngineCounts: Record<string, number>;
  results: SearchResult[];
}> {
  const opts = engineOpts(args.max_results_per_engine);
  if (CFG.mode === "single") {
    const id = (args.engine ?? CFG.singleEngine).toLowerCase();
    if (!isEngine(id)) {
      return {
        mode: "single",
        enginesUsed: [],
        unknownEngines: [id],
        perEngineCounts: {},
        results: [],
      };
    }
    let results: SearchResult[] = [];
    try {
      results = await ENGINES[id](args.query, opts);
    } catch {
      results = [];
    }
    return {
      mode: "single",
      enginesUsed: [id],
      unknownEngines: [],
      perEngineCounts: { [id]: results.length },
      results,
    };
  }

  const requested =
    args.engines && args.engines.length > 0
      ? args.engines.map((e) => e.toLowerCase())
      : CFG.multiEngines;
  const unknown = requested.filter((id) => !isEngine(id));
  const valid = requested.filter(isEngine);
  const perEngine = await Promise.all(
    valid.map(async (id) => {
      try {
        return { id, results: await ENGINES[id](args.query, opts) };
      } catch {
        return { id, results: [] as SearchResult[] };
      }
    }),
  );
  const counts: Record<string, number> = {};
  for (const p of perEngine) counts[p.id] = p.results.length;
  const maxLen = Math.max(...perEngine.map((p) => p.results.length), 0);
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (let i = 0; i < maxLen; i++) {
    for (const p of perEngine) {
      const r = p.results[i];
      if (!r) continue;
      const key = r.url.replace(/[#?].*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  }
  return {
    mode: "multi",
    enginesUsed: valid,
    unknownEngines: unknown,
    perEngineCounts: counts,
    results: merged,
  };
}

// ---------- MCP server ----------

const server = new Server(
  { name: "multi-search", version: "0.1.0" },
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
        };
        break;
      case "web_search": {
        const r = await runSearch({
          query: String(args.query ?? ""),
          engine: args.engine,
          engines: args.engines,
          max_results_per_engine: args.max_results_per_engine,
        });
        result = {
          query: args.query,
          mode: r.mode,
          engines_used: r.enginesUsed,
          unknown_engines: r.unknownEngines,
          per_engine_counts: r.perEngineCounts,
          total: r.results.length,
          results: r.results,
        };
        break;
      }
      case "fetch_page":
        result = await fetchAndExtract(String(args.url), fetchOpts(args.max_content_length));
        break;
      case "web_search_full": {
        const r = await runSearch({
          query: String(args.query ?? ""),
          engine: args.engine,
          engines: args.engines,
          max_results_per_engine: args.max_results_per_engine,
        });
        const topN = Math.max(0, Math.min(10, args.fetch_top_n ?? CFG.fetchTopN));
        const urls = r.results.slice(0, topN).map((x) => x.url);
        const pages = topN > 0 ? await fetchAndExtractMany(urls, fetchOpts(), CFG.fetchConcurrency) : [];
        const byUrl = new Map(pages.map((p) => [p.url, p]));
        result = {
          query: args.query,
          mode: r.mode,
          engines_used: r.enginesUsed,
          total_results: r.results.length,
          fetched: pages.length,
          results: r.results.map((res, i) => ({
            ...res,
            page: i < topN ? byUrl.get(res.url) ?? null : null,
          })),
        };
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
  // Don't log to stdout — that channel belongs to the MCP transport.
  process.stderr.write("multi-search MCP server ready on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
