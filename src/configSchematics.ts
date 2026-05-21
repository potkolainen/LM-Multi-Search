import { createConfigSchematics } from "@lmstudio/sdk";
import { ALL_ENGINE_IDS } from "./engines";

// Engines enabled by default in multi-mode.
const DEFAULT_MULTI = new Set(["duckduckgo", "brave", "bing", "wikipedia"]);

// Pretty labels for the checkbox rows.
export const ENGINE_LABELS: Record<string, string> = {
  duckduckgo: "DuckDuckGo",
  brave: "Brave Search",
  bing: "Bing",
  qwant: "Qwant",
  ecosia: "Ecosia",
  startpage: "Startpage",
  metager: "MetaGer",
  wikipedia: "Wikipedia",
  arxiv: "arXiv",
  reddit: "Reddit",
  stackoverflow: "StackOverflow",
  github: "GitHub",
  "google-scholar": "Google Scholar",
  devdocs: "DevDocs (MDN)",
};

// Per-engine toggle field key. Boolean fields don't allow '-' in the id, so
// normalise. Exported so toolsProvider can read the same keys.
export function engineToggleKey(id: string): string {
  return `engine_${id.replace(/-/g, "_")}`;
}

// Build the per-chat schematics. Uses `any` for the accumulator because the
// builder's chain type narrows on every call, which is fine for runtime but
// awkward when building dynamically.
function buildConfigSchematics() {
  let b: any = createConfigSchematics()
    .field(
      "searchEnabled",
      "boolean",
      {
        displayName: "Enable Web Search",
        subtitle: "Master switch. When off, the model has no search tools at all.",
      },
      true,
    )
    .field(
      "mode",
      "select",
      {
        displayName: "Search Mode",
        subtitle:
          "Single = one engine per query. Multi = fan out across the engines checked below in parallel.",
        options: [
          { value: "single", displayName: "Single engine" },
          { value: "multi", displayName: "Multi engine (parallel)" },
        ],
      },
      "single",
    )
    .field(
      "singleEngine",
      "select",
      {
        displayName: "Single-Mode Engine",
        subtitle: "Engine used when mode = Single.",
        options: ALL_ENGINE_IDS.map((id) => ({
          value: id,
          displayName: ENGINE_LABELS[id] ?? id,
        })),
      },
      "duckduckgo",
    )
    .field(
      "maxResultsPerEngine",
      "numeric",
      {
        displayName: "Max Results Per Engine",
        subtitle: "Hard cap on how many results each engine may return (1–20).",
        int: true,
        min: 1,
        max: 20,
      },
      5,
    )
    .field(
      "fetchTopN",
      "numeric",
      {
        displayName: "web_search_full: Pages to fetch",
        subtitle: "How many of the top search results to actually fetch and read.",
        int: true,
        min: 0,
        max: 10,
      },
      3,
    )
    .field(
      "fetchConcurrency",
      "numeric",
      {
        displayName: "Fetch concurrency",
        subtitle: "How many page fetches run in parallel (1–8).",
        int: true,
        min: 1,
        max: 8,
      },
      3,
    )
    .field(
      "topK",
      "numeric",
      {
        displayName: "Top-K results returned",
        subtitle:
          "Final number of best-scoring results returned to the model after filtering & ranking (1–25).",
        int: true,
        min: 1,
        max: 25,
      },
      8,
    )
    .field(
      "snippetMaxChars",
      "numeric",
      {
        displayName: "Snippet length cap (chars)",
        subtitle:
          "Trim long snippets to save context. Lower = less noise, higher = more evidence per result.",
        int: true,
        min: 80,
        max: 2000,
      },
      240,
    )
    .field(
      "cacheTtlSec",
      "numeric",
      {
        displayName: "Search cache TTL (seconds)",
        subtitle:
          "In-memory cache of recent search responses to avoid duplicate calls. 0 disables caching.",
        int: true,
        min: 0,
        max: 3600,
      },
      300,
    )
    .field(
      "includeScoreBreakdown",
      "boolean",
      {
        displayName: "Include score breakdown",
        subtitle:
          "Attach a per-result explanation of why it scored what it did (transparency / debugging).",
      },
      false,
    );

  // One checkbox per engine — these are the Multi-mode engine toggles.
  for (const id of ALL_ENGINE_IDS) {
    b = b.field(
      engineToggleKey(id),
      "boolean",
      {
        displayName: `Multi: ${ENGINE_LABELS[id] ?? id}`,
        subtitle: `Include "${id}" when Multi mode is active.`,
      },
      DEFAULT_MULTI.has(id),
    );
  }

  return b.build();
}

export const configSchematics = buildConfigSchematics();

export const globalConfigSchematics = createConfigSchematics()
  .field(
    "requestTimeoutMs",
    "numeric",
    {
      displayName: "Request Timeout (ms)",
      subtitle: "Per-engine HTTP timeout.",
      int: true,
      min: 1000,
      max: 60000,
    },
    15000,
  )
  .field(
    "pageFetchTimeoutMs",
    "numeric",
    {
      displayName: "Page Fetch Timeout (ms)",
      subtitle: "Timeout for fetch_page / web_search_full page loads.",
      int: true,
      min: 1000,
      max: 60000,
    },
    10000,
  )
  .field(
    "maxContentLength",
    "numeric",
    {
      displayName: "Max Content Length (chars)",
      subtitle:
        "Hard cap on extracted page text length. Equivalent to MAX_CONTENT_LENGTH in web-search-mcp.",
      int: true,
      min: 500,
      max: 200000,
    },
    10000,
  )
  .field(
    "userAgent",
    "string",
    {
      displayName: "User-Agent",
      subtitle: "User-Agent header sent to search engines and pages.",
    },
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  )
  .build();
