// Result ranking, filtering, and noise reduction. Pure functions, no I/O.
// Shared between the LM Studio plugin and the standalone MCP server.

import type { SearchResult } from "./engines";

// ---------- URL normalization ----------

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_$|source$|spm$)/i;

// Some engines return wrapper / redirect URLs that aren't real destinations.
// Drop these outright.
const REDIRECT_HOST_PREFIXES = [
  "duckduckgo.com/l/",
  "duckduckgo.com/y.js",
  "www.google.com/url",
  "www.bing.com/ck/",
  "r.jina.ai/",
];

export function isRedirectUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return REDIRECT_HOST_PREFIXES.some((p) => lower.includes(p));
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    // Strip tracking-ish params.
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) {
      if (TRACKING_PARAM_RE.test(k)) continue;
      keep.push([k, v]);
    }
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    // Strip trailing slash on path (but keep "/").
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- Host trust ----------

// Coarse trust score per host suffix. Higher = more reliable / authoritative.
// Used as one of several signals in scoring; not a hard filter.
const HOST_TRUST: Array<[RegExp, number]> = [
  [/(^|\.)wikipedia\.org$/, 0.95],
  [/(^|\.)wikimedia\.org$/, 0.9],
  [/(^|\.)arxiv\.org$/, 0.9],
  [/(^|\.)nature\.com$/, 0.9],
  [/(^|\.)science\.org$/, 0.9],
  [/(^|\.)nih\.gov$/, 0.9],
  [/(^|\.)ncbi\.nlm\.nih\.gov$/, 0.9],
  [/\.gov$/, 0.85],
  [/\.edu$/, 0.8],
  [/(^|\.)github\.com$/, 0.8],
  [/(^|\.)stackoverflow\.com$/, 0.8],
  [/(^|\.)stackexchange\.com$/, 0.75],
  [/(^|\.)mozilla\.org$/, 0.8],
  [/(^|\.)developer\.mozilla\.org$/, 0.85],
  [/(^|\.)readthedocs\.io$/, 0.75],
  [/(^|\.)microsoft\.com$/, 0.7],
  [/(^|\.)apple\.com$/, 0.7],
  [/(^|\.)bbc\.(co\.uk|com)$/, 0.75],
  [/(^|\.)reuters\.com$/, 0.75],
  [/(^|\.)apnews\.com$/, 0.75],
  [/(^|\.)nytimes\.com$/, 0.7],
  [/(^|\.)theguardian\.com$/, 0.7],
  [/(^|\.)reddit\.com$/, 0.55],
  [/(^|\.)medium\.com$/, 0.5],
  [/(^|\.)quora\.com$/, 0.45],
  [/(^|\.)pinterest\.(com|.+)$/, 0.2],
  [/(^|\.)answers\.com$/, 0.2],
];

export function hostTrust(host: string): number {
  for (const [re, score] of HOST_TRUST) if (re.test(host)) return score;
  return 0.5; // unknown host
}

// ---------- Query/text matching ----------

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "and", "or", "but",
  "is", "are", "was", "were", "be", "by", "with", "from", "as", "it", "its",
  "this", "that", "these", "those", "i", "you", "we", "they", "he", "she",
  "me", "him", "her", "us", "them", "my", "your", "our", "their",
  "how", "what", "when", "where", "why", "who", "which", "do", "does", "did",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "about", "into", "over", "under", "than", "then", "so", "if", "not", "no",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function queryTokens(query: string): string[] {
  return Array.from(new Set(tokenize(query)));
}

// 0..1 — what fraction of the query's content tokens appear in `text`.
export function overlapScore(qTokens: string[], text: string): number {
  if (qTokens.length === 0) return 0;
  const tt = new Set(tokenize(text));
  let hit = 0;
  for (const t of qTokens) if (tt.has(t)) hit++;
  return hit / qTokens.length;
}

// ---------- Result scoring ----------

export interface ScoredResult extends SearchResult {
  score: number;
  host: string;
  score_breakdown?: {
    host_trust: number;
    title_overlap: number;
    snippet_overlap: number;
    snippet_length_bonus: number;
  };
}

export interface RankOptions {
  query: string;
  topK: number;
  snippetMaxChars: number;
  includeScoreBreakdown?: boolean;
}

function trimSnippet(s: string, max: number): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + "…";
}

// Drop junk: empty title or URL, redirect wrappers, missing http(s) scheme.
function isUsable(r: SearchResult): boolean {
  if (!r.url || !r.title) return false;
  if (!/^https?:\/\//i.test(r.url)) return false;
  if (isRedirectUrl(r.url)) return false;
  if (r.title.trim().length < 2) return false;
  return true;
}

// Filter junk, dedupe by normalized URL, score, sort, top-K, trim snippets.
export function rankAndFilter(
  results: SearchResult[],
  opts: RankOptions,
): ScoredResult[] {
  const qTokens = queryTokens(opts.query);
  const seen = new Map<string, ScoredResult>();

  for (const r of results) {
    if (!isUsable(r)) continue;
    const normUrl = normalizeUrl(r.url);
    const host = hostOf(normUrl);
    const trust = hostTrust(host);
    const titleOverlap = overlapScore(qTokens, r.title);
    const snippetOverlap = overlapScore(qTokens, r.snippet || "");
    const snipLen = (r.snippet || "").length;
    // Reward results that actually have a snippet (>40 chars) up to ~0.3.
    const snipBonus = Math.min(0.3, snipLen / 600);

    // Weighted blend. Title overlap dominates; trust is a meaningful prior;
    // snippet evidence is secondary; length is a tiebreaker.
    const score =
      0.45 * titleOverlap +
      0.30 * trust +
      0.20 * snippetOverlap +
      0.05 * snipBonus;

    const scored: ScoredResult = {
      title: r.title.trim(),
      snippet: trimSnippet(r.snippet || "", opts.snippetMaxChars),
      url: normUrl,
      source: r.source,
      host,
      score: Math.round(score * 1000) / 1000,
      ...(opts.includeScoreBreakdown
        ? {
            score_breakdown: {
              host_trust: trust,
              title_overlap: Math.round(titleOverlap * 1000) / 1000,
              snippet_overlap: Math.round(snippetOverlap * 1000) / 1000,
              snippet_length_bonus: Math.round(snipBonus * 1000) / 1000,
            },
          }
        : {}),
    };

    // Dedupe: keep the higher-scoring instance per normalized URL.
    const existing = seen.get(normUrl);
    if (!existing || scored.score > existing.score) {
      seen.set(normUrl, scored);
    }
  }

  const sorted = Array.from(seen.values()).sort((a, b) => b.score - a.score);
  return sorted.slice(0, opts.topK);
}
