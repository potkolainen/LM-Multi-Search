import { text, tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import {
  configSchematics,
  engineToggleKey,
  globalConfigSchematics,
} from "./configSchematics";
import { ALL_ENGINE_IDS, ENGINES, EngineOptions, SearchResult, isEngine } from "./engines";
import { fetchAndExtract, fetchAndExtractMany, FetchPageOptions } from "./extract";

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const globalConfig = ctl.getPluginConfig(globalConfigSchematics);

  // Master kill-switch: when search is disabled, register no tools at all.
  if (!config.get("searchEnabled")) {
    return [];
  }

  const mode = config.get("mode"); // "single" | "multi"

  function buildEngineOpts(max?: number): EngineOptions {
    const cfgMax = config.get("maxResultsPerEngine");
    const maxResults = Math.max(1, Math.min(20, max ?? cfgMax));
    return {
      userAgent: globalConfig.get("userAgent"),
      timeoutMs: globalConfig.get("requestTimeoutMs"),
      maxResults,
    };
  }

  function buildFetchOpts(): FetchPageOptions {
    return {
      userAgent: globalConfig.get("userAgent"),
      timeoutMs: globalConfig.get("pageFetchTimeoutMs"),
      maxContentLength: globalConfig.get("maxContentLength"),
    };
  }

  // Reads the per-engine checkbox toggles and returns the list of engine ids
  // the user has currently enabled for multi-mode.
  function enabledMultiEngines(): string[] {
    return ALL_ENGINE_IDS.filter((id) => {
      const key = engineToggleKey(id);
      // `config.get` is strongly-typed against the builder; cast to satisfy
      // TS for our dynamically-named fields.
      return Boolean((config.get as (k: string) => unknown)(key));
    });
  }

  const listSearchEnginesTool = tool({
    name: "list_search_engines",
    description: text`
      Returns the list of supported search engine ids that can be passed to
      \`web_search\` (as \`engine\`). Also returns the user's current mode
      (single vs multi) and the configured engine selection.
    `,
    parameters: {},
    implementation: async () => ({
      engines: ALL_ENGINE_IDS,
      mode,
      single_engine: config.get("singleEngine"),
      multi_engines: enabledMultiEngines(),
    }),
  });

  // ----- single-engine mode -----
  const singleSearchTool = tool({
    name: "web_search",
    description: text`
      Performs an online web search against a single engine and returns a short
      list of results (title, snippet, url, source). If \`engine\` is omitted,
      the user's configured single-mode engine is used.

      Good general engines: duckduckgo, brave, bing, wikipedia.
      Specialized engines: arxiv (papers), reddit (discussions),
      stackoverflow (Q&A), github (repos), devdocs (MDN), google-scholar.
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engine: z
        .string()
        .optional()
        .describe("Engine id (see list_search_engines). Optional."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results to return (1–20)."),
    },
    implementation: async ({ query, engine, max_results }, { warn }) => {
      const id = (engine ?? config.get("singleEngine")).toLowerCase();
      if (!isEngine(id)) {
        return { error: `Unknown engine: ${id}`, available: ALL_ENGINE_IDS };
      }
      const opts = buildEngineOpts(max_results);
      try {
        const results = await ENGINES[id](query, opts);
        return { engine: id, query, count: results.length, results };
      } catch (e: any) {
        warn(`Engine ${id} failed: ${e?.message ?? e}`);
        return { engine: id, query, count: 0, results: [] as SearchResult[] };
      }
    },
  });

  // ----- multi-engine mode -----
  const multiSearchTool = tool({
    name: "web_search",
    description: text`
      Runs the query against MULTIPLE search engines in parallel (the engines
      the user pre-selected in plugin settings) and returns a merged,
      de-duplicated list of results. Each result keeps its \`source\` field so
      you know which engine produced it.

      You can override the engine list with \`engines\`, but normally just call
      this with a \`query\` and let the user's configured set be used.
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engines: z
        .array(z.string())
        .optional()
        .describe(
          "Optional override list of engine ids. Defaults to the user's configured multi engines.",
        ),
      max_results_per_engine: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results per engine (1–20)."),
    },
    implementation: async ({ query, engines, max_results_per_engine }, { warn }) => {
      const requested =
        engines && engines.length > 0
          ? engines.map((e) => e.toLowerCase())
          : enabledMultiEngines();

      const valid: string[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        if (isEngine(id)) valid.push(id);
        else unknown.push(id);
      }
      if (valid.length === 0) {
        return {
          error:
            "No engines enabled for Multi mode. Open the plugin's per-chat settings and tick at least one 'Multi:' engine checkbox.",
          unknown,
          available: ALL_ENGINE_IDS,
        };
      }

      const opts = buildEngineOpts(max_results_per_engine);

      const perEngine = await Promise.all(
        valid.map(async (id) => {
          try {
            const r = await ENGINES[id](query, opts);
            return { id, results: r };
          } catch (e: any) {
            warn(`Engine ${id} failed: ${e?.message ?? e}`);
            return { id, results: [] as SearchResult[] };
          }
        }),
      );

      // Round-robin interleave, dedupe by URL (ignoring ?/#).
      const maxLen = Math.max(...perEngine.map((p) => p.results.length), 0);
      const merged: SearchResult[] = [];
      const seen = new Set<string>();
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
        query,
        engines_used: valid,
        unknown_engines: unknown,
        per_engine_counts: Object.fromEntries(perEngine.map((p) => [p.id, p.results.length])),
        total: merged.length,
        results: merged,
      };
    },
  });

  // Only expose the tool that matches the user's current mode, so the model
  // can't pick the "wrong" one. From the model's perspective there is always
  // exactly one tool called `web_search` — its behaviour is what changes
  // based on the user's toggle.
  const activeSearchTool = mode === "multi" ? multiSearchTool : singleSearchTool;

  // ----- fetch_page: read a single URL and return its main text -----
  const fetchPageTool = tool({
    name: "fetch_page",
    description: text`
      Fetches a single web page and returns its extracted main text content
      (title + body, with nav/ads/scripts stripped). Use this after a search
      when you want the actual article content, not just the snippet. Honour
      \`max_content_length\` to avoid blowing up the context window.
    `,
    parameters: {
      url: z.string().url().describe("The full http(s) URL of the page to fetch."),
      max_content_length: z
        .number()
        .int()
        .min(500)
        .max(200000)
        .optional()
        .describe("Hard cap on returned content length. Defaults to the plugin's setting."),
    },
    implementation: async ({ url, max_content_length }) => {
      const opts = buildFetchOpts();
      if (max_content_length) opts.maxContentLength = max_content_length;
      return await fetchAndExtract(url, opts);
    },
  });

  // ----- web_search_full: search + concurrently fetch top N pages -----
  const fullSearchTool = tool({
    name: "web_search_full",
    description: text`
      Like \`web_search\`, but also fetches the top results in parallel and
      returns their extracted page content alongside each result. Use this
      when you need to actually read the pages, not just see snippets. More
      expensive — keep \`fetch_top_n\` small (1–5).
    `,
    parameters: {
      query: z.string().min(1).describe("The search query."),
      engine: z
        .string()
        .optional()
        .describe(
          "In single mode: which engine to search. In multi mode: ignored; the user's checked engines are used.",
        ),
      engines: z
        .array(z.string())
        .optional()
        .describe("Multi mode only: optional override list of engine ids."),
      fetch_top_n: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("How many of the top results to fetch full content for (0–10)."),
      max_results_per_engine: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Search results per engine before fetching (1–20)."),
    },
    implementation: async ({ query, engine, engines, fetch_top_n, max_results_per_engine }, { warn }) => {
      const engineOpts = buildEngineOpts(max_results_per_engine);
      const fetchOpts = buildFetchOpts();
      const topN = Math.max(0, Math.min(10, fetch_top_n ?? config.get("fetchTopN")));
      const concurrency = config.get("fetchConcurrency");

      // Gather results using the same mode the user has selected.
      let merged: SearchResult[] = [];
      let enginesUsed: string[] = [];
      if (mode === "single") {
        const id = (engine ?? config.get("singleEngine")).toLowerCase();
        if (!isEngine(id)) return { error: `Unknown engine: ${id}`, available: ALL_ENGINE_IDS };
        enginesUsed = [id];
        try {
          merged = await ENGINES[id](query, engineOpts);
        } catch (e: any) {
          warn(`Engine ${id} failed: ${e?.message ?? e}`);
        }
      } else {
        const requested =
          engines && engines.length > 0
            ? engines.map((e) => e.toLowerCase())
            : enabledMultiEngines();
        const valid = requested.filter(isEngine);
        if (valid.length === 0) {
          return {
            error:
              "No engines enabled for Multi mode. Open the plugin's per-chat settings and tick at least one 'Multi:' engine checkbox.",
            available: ALL_ENGINE_IDS,
          };
        }
        enginesUsed = valid;
        const perEngine = await Promise.all(
          valid.map(async (id) => {
            try {
              return { id, results: await ENGINES[id](query, engineOpts) };
            } catch (e: any) {
              warn(`Engine ${id} failed: ${e?.message ?? e}`);
              return { id, results: [] as SearchResult[] };
            }
          }),
        );
        const maxLen = Math.max(...perEngine.map((p) => p.results.length), 0);
        const seen = new Set<string>();
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
      }

      const toFetch = merged.slice(0, topN).map((r) => r.url);
      const pages = topN > 0 ? await fetchAndExtractMany(toFetch, fetchOpts, concurrency) : [];
      const byUrl = new Map(pages.map((p) => [p.url, p]));

      const enriched = merged.map((r, i) => ({
        ...r,
        page: i < topN ? byUrl.get(r.url) ?? null : null,
      }));

      return {
        query,
        mode,
        engines_used: enginesUsed,
        total_results: merged.length,
        fetched: pages.length,
        results: enriched,
      };
    },
  });

  return [listSearchEnginesTool, activeSearchTool, fetchPageTool, fullSearchTool];
}
