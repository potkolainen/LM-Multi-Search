// Search engine implementations for the multi-search LM Studio plugin.
// Ported from the Rust+Python implementation in ai-workspace-tauri.
//
// Each engine is a pure function: (query, opts) => Promise<SearchResult[]>.
// Engines never fall back to each other — on failure they return [].

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}

export interface EngineOptions {
  userAgent: string;
  timeoutMs: number;
  maxResults: number;
}

export type EngineFn = (q: string, opts: EngineOptions) => Promise<SearchResult[]>;

// ---------- helpers ----------

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function fetchText(url: string, opts: EngineOptions, extraHeaders: Record<string, string> = {}): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": opts.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T = any>(url: string, opts: EngineOptions): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractAllLinks(html: string): string[] {
  const out: string[] = [];
  const re = /href="(https?:\/\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

// ---------- engines ----------

const duckduckgo: EngineFn = async (q, opts) => {
  const url = `https://duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const html = await fetchText(url, opts, { Referer: "https://duckduckgo.com/" });
  if (!html) return [];
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    let url = decodeHtmlEntities(m[1]).trim();
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const snipM = /class="result__snippet"[^>]*>([^<]+)</.exec(after);
    const snippet = snipM ? decodeHtmlEntities(snipM[1]).trim() : "";
    results.push({
      title: decodeHtmlEntities(m[2]).trim().slice(0, 200),
      snippet: snippet.slice(0, 280),
      url,
      source: "duckduckgo",
    });
    if (results.length >= opts.maxResults) break;
  }
  return results;
};

const brave: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://search.brave.com/search?q=${encodeURIComponent(q)}`, opts);
  if (!html) return [];
  const links = extractAllLinks(html).filter(
    (l) => !l.includes("brave.com") && !l.includes("brave-search"),
  );
  const titles = Array.from(html.matchAll(/<span[^>]*class="[^"]*snippet-title[^"]*"[^>]*>([^<]+)<\/span>/g)).map((m) => decodeHtmlEntities(m[1]).trim());
  return links.slice(0, opts.maxResults).map((url, i) => ({
    title: (titles[i] ?? hostOf(url)).slice(0, 200),
    snippet: "Result from Brave Search",
    url,
    source: "brave",
  }));
};

const bing: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, opts);
  if (!html) return [];
  const h2Links = Array.from(html.matchAll(/<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"/g)).map((m) => m[1]);
  const external = extractAllLinks(html).filter(
    (l) => !l.includes("bing.com") && !l.includes("microsoft.com") && !l.includes("msn.com"),
  );
  const links = (h2Links.length ? h2Links : external).slice(0, opts.maxResults);
  return links.map((url, i) => ({
    title: `Bing result ${i + 1}: ${hostOf(url)}`,
    snippet: "Search result from Bing",
    url,
    source: "bing",
  }));
};

const ecosia: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://www.ecosia.org/search?q=${encodeURIComponent(q)}&method=index`, opts);
  if (!html) return [];
  const external = extractAllLinks(html).filter(
    (l) => !l.includes("ecosia.org") && !l.includes("bing.com"),
  );
  return external.slice(0, opts.maxResults).map((url, i) => ({
    title: `Ecosia: ${hostOf(url)}`,
    snippet: "Plant trees while searching",
    url,
    source: "ecosia",
  }));
};

const qwant: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://www.qwant.com/?q=${encodeURIComponent(q)}&t=web`, opts);
  if (!html) return [];
  const links = extractAllLinks(html).filter(
    (l) => !l.includes("qwant.com") && !l.includes("qwantify.com"),
  );
  return links.slice(0, opts.maxResults).map((url) => ({
    title: hostOf(url),
    snippet: url,
    url,
    source: "qwant",
  }));
};

const startpage: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`, opts);
  if (!html) return [];
  const links = extractAllLinks(html).filter(
    (l) => !l.includes("startpage.com") && !l.includes("ixquick.com"),
  );
  return links.slice(0, opts.maxResults).map((url, i) => ({
    title: `Startpage result ${i + 1}: ${hostOf(url)}`,
    snippet: "Privacy-focused result",
    url,
    source: "startpage",
  }));
};

const metager: EngineFn = async (q, opts) => {
  const html = await fetchText(
    `https://metager.org/meta/meta.ger3?eingabe=${encodeURIComponent(q)}&focus=web`,
    opts,
  );
  if (!html) return [];
  const links = extractAllLinks(html).filter((l) => !l.includes("metager.org"));
  return links.slice(0, opts.maxResults).map((url, i) => ({
    title: `MetaGer result ${i + 1}: ${hostOf(url)}`,
    snippet: "Privacy-focused meta-search",
    url,
    source: "metager",
  }));
};

const googleScholar: EngineFn = async (q, opts) => {
  const html = await fetchText(`https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`, opts);
  if (!html) return [];
  const links = extractAllLinks(html).filter(
    (l) => !l.includes("scholar.google") && !l.includes("google.com"),
  );
  return links.slice(0, opts.maxResults).map((url, i) => ({
    title: `Scholar result ${i + 1}: ${hostOf(url)}`,
    snippet: "Academic result via Google Scholar",
    url,
    source: "google-scholar",
  }));
};

const devdocs: EngineFn = async (q, opts) => {
  // MDN proxy (DevDocs is fully client-side).
  const html = await fetchText(`https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}`, opts);
  if (!html) return [];
  const paths = Array.from(html.matchAll(/href="(\/en-US\/docs\/[^"]+)"/g)).map((m) => m[1]);
  const uniq = Array.from(new Set(paths)).slice(0, opts.maxResults);
  return uniq.map((p) => ({
    title: `MDN: ${p.split("/").pop()!.replace(/_/g, " ")}`,
    snippet: "Mozilla Developer Network documentation",
    url: `https://developer.mozilla.org${p}`,
    source: "devdocs",
  }));
};

const arxiv: EngineFn = async (q, opts) => {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${opts.maxResults}`;
  const xml = await fetchText(url, opts);
  if (!xml) return [];
  const results: SearchResult[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const t = /<title>([\s\S]*?)<\/title>/.exec(entry);
    const idM = /<id>(http:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/.exec(entry);
    const sumM = /<summary>([\s\S]{0,400})/.exec(entry);
    if (t && idM) {
      results.push({
        title: decodeHtmlEntities(t[1]).trim().slice(0, 200),
        snippet: (sumM ? sumM[1].trim() : "Academic paper on arXiv").slice(0, 280),
        url: idM[1],
        source: "arxiv",
      });
    }
  }
  return results.slice(0, opts.maxResults);
};

const wikipedia: EngineFn = async (q, opts) => {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${opts.maxResults}&format=json`;
  const data = await fetchJson<any[]>(url, opts);
  if (!Array.isArray(data) || data.length < 4) return [];
  const titles = data[1] as string[];
  const descs = data[2] as string[];
  const urls = data[3] as string[];
  const out: SearchResult[] = [];
  for (let i = 0; i < Math.min(titles.length, urls.length, opts.maxResults); i++) {
    if (urls[i]) {
      out.push({
        title: titles[i],
        snippet: descs[i] || titles[i],
        url: urls[i],
        source: "wikipedia",
      });
    }
  }
  return out;
};

const reddit: EngineFn = async (q, opts) => {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=${opts.maxResults}&sort=relevance`;
  const data = await fetchJson<any>(url, opts);
  const children = data?.data?.children;
  if (!Array.isArray(children)) return [];
  return children.slice(0, opts.maxResults).map((p: any) => {
    const d = p.data || {};
    const snippet = d.selftext
      ? String(d.selftext).slice(0, 200) + (String(d.selftext).length > 200 ? "..." : "")
      : `Discussion in r/${d.subreddit ?? ""}`;
    return {
      title: String(d.title ?? "(no title)"),
      snippet,
      url: `https://reddit.com${d.permalink ?? ""}`,
      source: "reddit",
    } as SearchResult;
  });
};

// DDG site:-search helpers
async function ddgSiteSearch(query: string, opts: EngineOptions): Promise<string[]> {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, opts);
  if (!html) return [];
  const out: string[] = [];
  for (const m of html.matchAll(/\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)/g)) {
    out.push(decodeURIComponent(m[1]));
  }
  return out;
}

const stackoverflow: EngineFn = async (q, opts) => {
  const urls = await ddgSiteSearch(`site:stackoverflow.com ${q}`, opts);
  const results: SearchResult[] = [];
  for (const url of urls) {
    if (url.includes("stackoverflow.com/questions/")) {
      const last = url.split("/").filter(Boolean).pop() ?? "StackOverflow";
      const title = last.replace(/-/g, " ").slice(0, 200);
      results.push({ title, snippet: title, url, source: "stackoverflow" });
      if (results.length >= opts.maxResults) break;
    }
  }
  return results;
};

const github: EngineFn = async (q, opts) => {
  const urls = await ddgSiteSearch(`${q} github`, opts);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const url of urls) {
    if (!url.includes("github.com/")) continue;
    const parts = url.replace(/https?:\/\/github\.com\//, "").split("/").filter(Boolean);
    if (parts.length >= 2 && !["topics", "search", "orgs"].includes(parts[0])) {
      const repo = `${parts[0]}/${parts[1]}`;
      if (seen.has(repo)) continue;
      seen.add(repo);
      results.push({
        title: repo,
        snippet: `Repository: ${repo}`,
        url: `https://github.com/${repo}`,
        source: "github",
      });
      if (results.length >= opts.maxResults) break;
    }
  }
  return results;
};

// ---------- registry ----------

export const ENGINES: Record<string, EngineFn> = {
  duckduckgo,
  brave,
  bing,
  qwant,
  ecosia,
  startpage,
  metager,
  wikipedia,
  arxiv,
  reddit,
  stackoverflow,
  github,
  "google-scholar": googleScholar,
  devdocs,
};

export const ALL_ENGINE_IDS = Object.keys(ENGINES);

export function isEngine(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENGINES, id);
}
