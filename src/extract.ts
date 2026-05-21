// Minimal, dependency-free HTML → main-text extractor.
// Inspired by what get-single-web-page-content does in mrkrsl/web-search-mcp,
// but without Playwright or @mozilla/readability — we just strip noise tags,
// pick the largest reasonable content container, and de-tag/whitespace it.

export interface FetchPageOptions {
  userAgent: string;
  timeoutMs: number;
  maxContentLength: number;
}

export interface ExtractedPage {
  url: string;
  final_url: string;
  status: number;
  title: string;
  content: string;
  truncated: boolean;
  byte_length: number;
  error?: string;
}

const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "nav",
  "aside",
  "footer",
  "header",
];

function stripTag(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  return html.replace(re, " ");
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractFirst(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(html);
  return m ? m[1] : null;
}

function htmlToText(html: string): string {
  // Convert block-level elements to newlines before stripping tags so we don't
  // glue words together.
  const blockified = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ");
  const noTags = blockified.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(noTags);
  // Collapse whitespace per line, then collapse multiple blank lines.
  return decoded
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .filter((line, i, a) => !(line === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

function pickMainContainer(html: string): string {
  // Prefer <article>, then <main>, then the largest <div> by text length.
  const article = extractFirst(html, "article");
  if (article && article.length > 200) return article;
  const main = extractFirst(html, "main");
  if (main && main.length > 200) return main;

  // Fall back: scan top-level <div> blocks and keep the longest one whose
  // visible text is reasonable.
  let best = html;
  let bestLen = htmlToText(html).length;
  const divRe = /<div\b[^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = divRe.exec(html)) !== null) {
    const inner = m[1];
    const textLen = htmlToText(inner).length;
    if (textLen > bestLen) {
      best = inner;
      bestLen = textLen;
    }
  }
  return best;
}

export async function fetchAndExtract(url: string, opts: FetchPageOptions): Promise<ExtractedPage> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": opts.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    const finalUrl = res.url || url;
    const status = res.status;
    if (!res.ok) {
      return {
        url,
        final_url: finalUrl,
        status,
        title: "",
        content: "",
        truncated: false,
        byte_length: 0,
        error: `HTTP ${status}`,
      };
    }
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const byteLen = raw.length;

    if (!/html|xml|text\/plain/i.test(ct) && !/^\s*</.test(raw)) {
      // Non-HTML: return truncated raw text.
      const truncated = raw.length > opts.maxContentLength;
      return {
        url,
        final_url: finalUrl,
        status,
        title: "",
        content: raw.slice(0, opts.maxContentLength),
        truncated,
        byte_length: byteLen,
      };
    }

    let html = raw;
    html = stripComments(html);
    for (const tag of NOISE_TAGS) html = stripTag(html, tag);

    const titleHtml = extractFirst(html, "title") ?? "";
    const title = decodeEntities(titleHtml.replace(/<[^>]+>/g, " ").trim()).slice(0, 300);

    const body = extractFirst(html, "body") ?? html;
    const main = pickMainContainer(body);
    let content = htmlToText(main);

    const truncated = content.length > opts.maxContentLength;
    if (truncated) content = content.slice(0, opts.maxContentLength) + "…";

    return {
      url,
      final_url: finalUrl,
      status,
      title,
      content,
      truncated,
      byte_length: byteLen,
    };
  } catch (e: any) {
    return {
      url,
      final_url: url,
      status: 0,
      title: "",
      content: "",
      truncated: false,
      byte_length: 0,
      error: e?.name === "AbortError" ? "Timeout" : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAndExtractMany(
  urls: string[],
  opts: FetchPageOptions,
  concurrency: number,
): Promise<ExtractedPage[]> {
  const c = Math.max(1, Math.min(8, concurrency));
  const out: ExtractedPage[] = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await fetchAndExtract(urls[i], opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(c, urls.length) }, worker));
  return out;
}
