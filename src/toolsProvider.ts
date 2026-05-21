import { text, tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import {
  configSchematics,
  engineToggleKey,
  globalConfigSchematics,
} from "./configSchematics";
import { ALL_ENGINE_IDS, ENGINES, EngineOptions, SearchResult, isEngine } from "./engines";
import { fetchAndExtract, fetchAndExtractMany, FetchPageOptions } from "./extract";
import { rankAndFilter, ScoredResult } from "./ranking";
import { TtlLruCache } from "./cache";
import { getWeather } from "./weather";

// Threshold below which we tell the model the results look irrelevant.
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

// Engine ids inlined into descriptions so the model can pick a specific
// engine without first calling list_search_engines.
const ENGINE_HINT =
  "Available engines: duckduckgo, brave, bing, qwant, ecosia, startpage, " +
  "metager, wikipedia, arxiv, reddit, stackoverflow, github, google-scholar, " +
  "devdocs. Pick wikipedia for encyclopedic summaries, arxiv for papers, " +
  "github for code/repos, stackoverflow for programming Q&A, reddit for " +
  "discussion. For everything else, duckduckgo / brave / bing are good general engines.";

// Cache lives per worker process (re-created on plugin reload).
const searchCache = new TtlLruCache<SearchResult[]>(100, 5 * 60 * 1000);
const fullSearchCache = new TtlLruCache<any>(50, 5 * 60 * 1000);

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const globalConfig = ctl.getPluginConfig(globalConfigSchematics);

  // Master kill-switch.
  if (!config.get("searchEnabled")) return [];

  const mode = config.get("mode"); // "single" | "multi"
  const topK = config.get("topK");
  const snippetMaxChars = config.get("snippetMaxChars");
  const includeScoreBreakdown = config.get("includeScoreBreakdown");
  const cacheTtlMs = config.get("cacheTtlSec") * 1000;

  function buildEngineOpts(max?: number): EngineOptions {
    const cfgMax = config.get("maxResultsPerEngine");
    const maxResults = Math.max(1, Math.min(20, max ?? cfgMax));
    return {
      userAgent: globalConfig.get("userAgent"),
      timeoutMs: globalConfig.get("requestTimeoutMs"),
      maxResults,
    };
  }

  function buildFetchOpts(query?: string): FetchPageOptions {
    return {
      userAgent: globalConfig.get("userAgent"),
      timeoutMs: globalConfig.get("pageFetchTimeoutMs"),
      maxContentLength: globalConfig.get("maxContentLength"),
      query,
    };
  }

  function enabledMultiEngines(): string[] {
    return ALL_ENGINE_IDS.filter((id) => {
      const key = engineToggleKey(id);
      return Boolean((config.get as (k: string) => unknown)(key));
    });
  }

  // ---------- shared search runner (used by web_search + web_search_full) ----------

  type RunArgs = {
    query: string;
    engine?: string;
    engines?: string[];
    maxPerEngine?: number;
  };
  type RunOut = {
    enginesUsed: string[];
    unknownEngines: string[];
    perEngineCounts: Record<string, number>;
    raw: SearchResult[];
    fromCache: boolean;
  };

  async function runSearch(args: RunArgs, warn: (m: string) => void): Promise<RunOut> {
    const opts = buildEngineOpts(args.maxPerEngine);

    // Single mode.
    if (mode === "single") {
      const id = (args.engine ?? config.get("singleEngine")).toLowerCase();
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
      const cached = cacheTtlMs > 0 ? searchCache.get(cacheKey) : undefined;
      if (cached) {
        return {
          enginesUsed: [id],
          unknownEngines: [],
          perEngineCounts: { [id]: cached.length },
          raw: cached,
          fromCache: true,
        };
      }
      let results: SearchResult[] = [];
      try {
        results = await ENGINES[id](args.query, opts);
      } catch (e: any) {
        warn(`Engine ${id} failed: ${e?.message ?? e}`);
      }
      if (cacheTtlMs > 0) {
        searchCache.set(cacheKey, results);
      }
      return {
        enginesUsed: [id],
        unknownEngines: [],
        perEngineCounts: { [id]: results.length },
        raw: results,
        fromCache: false,
      };
    }

    // Multi mode.
    const requested =
      args.engines && args.engines.length > 0
        ? args.engines.map((e) => e.toLowerCase())
        : enabledMultiEngines();
    const unknown: string[] = [];
    const valid: string[] = [];
    for (const id of requested) (isEngine(id) ? valid : unknown).push(id);
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
    const cached = cacheTtlMs > 0 ? searchCache.get(cacheKey) : undefined;
    if (cached) {
      return {
        enginesUsed: valid,
        unknownEngines: unknown,
        perEngineCounts: valid.reduce<Record<string, number>>((a, id) => {
          a[id] = 0;
          return a;
        }, {}),
        raw: cached,
        fromCache: true,
      };
    }

    const perEngine = await Promise.all(
      valid.map(async (id) => {
        try {
          return { id, results: await ENGINES[id](args.query, opts) };
        } catch (e: any) {
          warn(`Engine ${id} failed: ${e?.message ?? e}`);
          return { id, results: [] as SearchResult[] };
        }
      }),
    );

    // Round-robin interleave (ranking will re-sort, but this gives a fair
    // starting order before scoring breaks ties).
    const maxLen = Math.max(...perEngine.map((p) => p.results.length), 0);
    const interleaved: SearchResult[] = [];
    for (let i = 0; i < maxLen; i++) {
      for (const p of perEngine) {
        const r = p.results[i];
        if (r) interleaved.push(r);
      }
    }

    if (cacheTtlMs > 0) searchCache.set(cacheKey, interleaved);

    return {
      enginesUsed: valid,
      unknownEngines: unknown,
      perEngineCounts: Object.fromEntries(perEngine.map((p) => [p.id, p.results.length])),
      raw: interleaved,
      fromCache: false,
    };
  }

  // ---------- tools ----------

  const listSearchEnginesTool = tool({
    name: "list_search_engines",
    description: text`
      Returns the list of supported search engine ids and the user's current
      mode (single/multi). You usually do NOT need to call this — the engine
      ids are: duckduckgo, brave, bing, qwant, ecosia, startpage, metager,
      wikipedia, arxiv, reddit, stackoverflow, github, google-scholar, devdocs.
    `,
    parameters: {},
    implementation: async () => ({
      engines: ALL_ENGINE_IDS,
      mode,
      single_engine: config.get("singleEngine"),
      multi_engines: enabledMultiEngines(),
      hint: "Prefer web_search_full over web_search+fetch_page when you need page content. For Wikipedia summaries pass engine: 'wikipedia'.",
    }),
  });

  // ----- single-engine web_search -----
  const singleSearchTool = tool({
    name: "web_search",
    description: text`
      Searches the web on a single engine and returns the top-K best results
      after de-duplication and host-trust ranking. Each result has: title,
      snippet (trimmed), url, source, host, score (0–1, higher is better).

      Usage rules:
      • Pass \`engine: 'wikipedia'\` for encyclopedic summaries, 'arxiv' for
        papers, 'github' for code, 'stackoverflow' for programming Q&A.
      • If you need the actual page content (not just snippets), call
        \`web_search_full\` INSTEAD of \`web_search\` + \`fetch_page\`. One call.
      • Do NOT retry the same query verbatim if results are poor — change the
        wording or switch engines.

      ${ENGINE_HINT}
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engine: z
        .string()
        .optional()
        .describe("Engine id (see description). Defaults to the user's configured engine."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("How many ranked results to return after filtering."),
    },
    implementation: async ({ query, engine, max_results }, { warn }) => {
      const r = await runSearch({ query, engine, maxPerEngine: max_results }, warn);
      if (r.enginesUsed.length === 0) {
        return {
          error: `Unknown engine: ${r.unknownEngines[0] ?? engine}`,
          available: ALL_ENGINE_IDS,
        };
      }
      const ranked = rankAndFilter(r.raw, {
        query,
        topK: max_results ?? topK,
        snippetMaxChars,
        includeScoreBreakdown,
      });
      const note = relevanceNote(ranked, query);
      return {
        query,
        engine: r.enginesUsed[0],
        from_cache: r.fromCache,
        returned: ranked.length,
        dropped_as_noise: r.raw.length - ranked.length,
        results: ranked,
        ...(note ? { note } : {}),
      };
    },
  });

  // ----- multi-engine web_search -----
  const multiSearchTool = tool({
    name: "web_search",
    description: text`
      Searches the web across MULTIPLE engines in parallel (the engines the
      user pre-selected) and returns a single de-duplicated, host-trust-ranked
      top-K list. Each result has: title, snippet (trimmed), url, source,
      host, score (0–1).

      Usage rules:
      • If you need page CONTENT, call \`web_search_full\` instead — it does
        the search + page fetch in one call.
      • If the user mentions a specific site (Wikipedia, GitHub, arXiv,
        Reddit, StackOverflow), pass \`engines: ["wikipedia"]\` etc. to
        restrict the search. Don't dump everything if they asked for one source.
      • Don't retry the same query verbatim — change wording or engines.

      ${ENGINE_HINT}
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engines: z
        .array(z.string())
        .optional()
        .describe(
          "Optional override engine list. Use this to target one site (e.g. ['wikipedia']) when the user asked for it.",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("How many ranked results to return after filtering."),
      max_results_per_engine: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Raw results requested per engine before ranking."),
    },
    implementation: async ({ query, engines, max_results, max_results_per_engine }, { warn }) => {
      const r = await runSearch({ query, engines, maxPerEngine: max_results_per_engine }, warn);
      if (r.enginesUsed.length === 0) {
        return {
          error:
            "No engines enabled for Multi mode. Either pass `engines: [...]` explicitly or have the user tick engines in plugin settings.",
          unknown_engines: r.unknownEngines,
          available: ALL_ENGINE_IDS,
        };
      }
      const ranked = rankAndFilter(r.raw, {
        query,
        topK: max_results ?? topK,
        snippetMaxChars,
        includeScoreBreakdown,
      });
      const note = relevanceNote(ranked, query);
      return {
        query,
        engines_used: r.enginesUsed,
        unknown_engines: r.unknownEngines,
        per_engine_counts: r.perEngineCounts,
        from_cache: r.fromCache,
        returned: ranked.length,
        dropped_as_noise: r.raw.length - ranked.length,
        results: ranked,
        ...(note ? { note } : {}),
      };
    },
  });

  const activeSearchTool = mode === "multi" ? multiSearchTool : singleSearchTool;

  // ----- fetch_page -----
  const fetchPageTool = tool({
    name: "fetch_page",
    description: text`
      Fetches a single URL and returns its extracted main text (title + body,
      with ads/nav/scripts stripped). Use this when you ALREADY have a URL
      and only need that one page's content.

      If you want to search AND read top results, use \`web_search_full\`
      instead — it combines both in one call and uses query-aware truncation
      to keep the most relevant paragraphs.
    `,
    parameters: {
      url: z.string().url().describe("The full http(s) URL of the page to fetch."),
      query: z
        .string()
        .optional()
        .describe(
          "Optional. If provided, when the page is too long the extractor keeps paragraphs containing these query terms instead of just the first N chars.",
        ),
      max_content_length: z
        .number()
        .int()
        .min(500)
        .max(200000)
        .optional()
        .describe("Hard cap on returned content length. Defaults to plugin setting."),
    },
    implementation: async ({ url, query, max_content_length }) => {
      const opts = buildFetchOpts(query);
      if (max_content_length) opts.maxContentLength = max_content_length;
      return await fetchAndExtract(url, opts);
    },
  });

  // ----- web_search_full -----
  const fullSearchTool = tool({
    name: "web_search_full",
    description: text`
      ONE-STOP tool: searches the web AND concurrently fetches the top N
      result pages, returning each result with its extracted main text
      attached as \`page.content\`. Page extraction is query-aware — for
      long pages it keeps paragraphs containing your query terms.

      Use this INSTEAD of doing \`web_search\` followed by multiple
      \`fetch_page\` calls. Keep \`fetch_top_n\` small (1–5) to limit context
      cost. Pass \`engines: ["wikipedia"]\` etc. to restrict to one source.

      ${ENGINE_HINT}
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engine: z.string().optional().describe("Single-mode engine override."),
      engines: z
        .array(z.string())
        .optional()
        .describe("Multi-mode engine list override (e.g. ['wikipedia'])."),
      fetch_top_n: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("How many of the top-ranked results to fetch full content for (0–10)."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("How many ranked results to return overall."),
      max_results_per_engine: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Raw results requested per engine before ranking."),
    },
    implementation: async (
      { query, engine, engines, fetch_top_n, max_results, max_results_per_engine },
      { warn },
    ) => {
      const fullKey = `f|${mode}|${engine ?? ""}|${(engines ?? []).slice().sort().join(",")}|${fetch_top_n ?? ""}|${max_results ?? ""}|${max_results_per_engine ?? ""}|${query}`;
      if (cacheTtlMs > 0) {
        const hit = fullSearchCache.get(fullKey);
        if (hit) return { ...hit, from_cache: true };
      }

      const r = await runSearch(
        { query, engine, engines, maxPerEngine: max_results_per_engine },
        warn,
      );
      if (r.enginesUsed.length === 0) {
        return {
          error:
            mode === "single"
              ? `Unknown engine: ${r.unknownEngines[0] ?? engine}`
              : "No engines enabled for Multi mode. Pass engines: [...] or have the user tick engines in settings.",
          available: ALL_ENGINE_IDS,
        };
      }

      const ranked: ScoredResult[] = rankAndFilter(r.raw, {
        query,
        topK: max_results ?? topK,
        snippetMaxChars,
        includeScoreBreakdown,
      });

      const topN = Math.max(0, Math.min(10, fetch_top_n ?? config.get("fetchTopN")));
      const concurrency = config.get("fetchConcurrency");
      const fetchOpts = buildFetchOpts(query);

      const toFetch = ranked.slice(0, topN).map((x) => x.url);
      const pages = topN > 0 ? await fetchAndExtractMany(toFetch, fetchOpts, concurrency) : [];
      const byUrl = new Map(pages.map((p) => [p.url, p]));

      const enriched = ranked.map((res, i) => ({
        ...res,
        page: i < topN ? byUrl.get(res.url) ?? null : null,
      }));

      const note = relevanceNote(ranked, query);
      const out = {
        query,
        mode,
        engines_used: r.enginesUsed,
        unknown_engines: r.unknownEngines,
        per_engine_counts: r.perEngineCounts,
        returned: ranked.length,
        dropped_as_noise: r.raw.length - ranked.length,
        fetched: pages.length,
        results: enriched,
        from_cache: false,
        ...(note ? { note } : {}),
      };
      if (cacheTtlMs > 0) fullSearchCache.set(fullKey, out);
      return out;
    },
  });

  // ----- get_weather -----
  const weatherTool = tool({
    name: "get_weather",
    description: text`
      Returns CURRENT weather conditions and a 3-day forecast for a city or
      location. USE THIS for any weather question — do NOT use web_search for
      weather, because search snippets rarely contain actual temperatures.

      Data source: wttr.in (free, no key). Pass any human location string:
      'Oulu', 'São Paulo, Brazil', 'New York', '94103' (US ZIP), 'London, UK',
      airport codes like 'JFK', etc.
    `,
    parameters: {
      location: z
        .string()
        .min(1)
        .describe("City, region, ZIP, or airport code. e.g. 'Oulu' or 'São Paulo, Brazil'."),
      units: z
        .enum(["metric", "imperial"])
        .optional()
        .describe("Temperature/wind units. Default: metric (°C, km/h)."),
      lang: z
        .string()
        .optional()
        .describe("ISO language code for the weather description (e.g. 'en', 'fi', 'pt')."),
    },
    implementation: async ({ location, units, lang }) => {
      return await getWeather(location, {
        userAgent: globalConfig.get("userAgent"),
        timeoutMs: globalConfig.get("requestTimeoutMs"),
        units,
        lang,
      });
    },
  });

  return [listSearchEnginesTool, activeSearchTool, fetchPageTool, fullSearchTool, weatherTool];
}
