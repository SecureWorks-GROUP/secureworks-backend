// Deterministic MakeSafe report-link extraction from builder email bodies.
// Pure helpers only: no network, no Supabase, no live sends.

export type BuilderEmailLink = {
  label: string;
  url: string;
  kind: string;
  source: "email_body" | "claude" | "legacy_portal_link";
};

type ExtractionLike = {
  portal_link?: unknown;
  portal_links?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const MAX_TRADE_EMAIL_TEXT = 6000;

function decodeHtmlEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
  };
  const raw = entity.slice(1, -1);
  if (raw.startsWith("#x") || raw.startsWith("#X")) {
    const code = Number.parseInt(raw.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  }
  if (raw.startsWith("#")) {
    const code = Number.parseInt(raw.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  }
  return named[raw.toLowerCase()] ?? entity;
}

export function decodeEmailHtmlEntitiesForTest(input: string): string {
  return String(input || "").replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|ndash|mdash|#\d+|#x[0-9a-f]+);/gi,
    decodeHtmlEntity,
  );
}

export function stripEmailHtmlForTrade(
  htmlOrText: string | null | undefined,
  maxChars = MAX_TRADE_EMAIL_TEXT,
): string {
  const raw = String(htmlOrText || "");
  if (!raw.trim()) return "";
  const withoutDangerous = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const hrefExpanded = withoutDangerous.replace(
    /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi,
    (_m, href) => `${href} `,
  );
  const lineBroken = hrefExpanded
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ");
  const noTags = lineBroken.replace(/<[^>]+>/g, " ");
  const decoded = decodeEmailHtmlEntitiesForTest(noTags);
  const normalisedLines = decoded
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalisedLines.slice(0, Math.max(0, maxChars)).trim();
}

function cleanUrl(url: string): string {
  let out = decodeEmailHtmlEntitiesForTest(String(url || "").trim());
  out = out.replace(/[)\].,;:'"!?]+$/g, "");
  try {
    const parsed = new URL(out);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function urlLooksLikeFooterOrTracking(url: string, context: string): boolean {
  const haystack = `${url}\n${context}`.toLowerCase();
  return /unsubscribe|privacy|terms|facebook|instagram|linkedin|twitter|x\.com|tracking|track|pixel|open\.aspx|click\.|utm_medium=email_signature|logo|image001|spacer/
    .test(haystack);
}

function classifyBuilderLink(
  context: string,
): { label: string; kind: string } | null {
  const c = context.toLowerCase();
  if (
    /unsubscribe|privacy|terms|copyright|facebook|instagram|linkedin|twitter|logo/
      .test(c)
  ) return null;
  if (/roof/.test(c)) return { label: "Roof report link", kind: "roof_report" };
  if (/assessment|assess|inspect/.test(c)) {
    return { label: "Assessment report link", kind: "assessment_report" };
  }
  if (/quote|quotation|estimate/.test(c)) {
    return { label: "Quote link", kind: "quote" };
  }
  if (/photo|image|evidence/.test(c)) {
    return { label: "Photo/report portal link", kind: "photos" };
  }
  if (/report|portal|prime|mlb|builder/.test(c)) {
    return { label: "Builder portal link", kind: "builder_portal" };
  }
  return { label: "Builder portal link", kind: "builder_portal" };
}

export function extractBuilderEmailLinks(
  bodyTextOrHtml: string | null | undefined,
): BuilderEmailLink[] {
  const text = stripEmailHtmlForTrade(bodyTextOrHtml, 20000);
  if (!text) return [];

  const links: BuilderEmailLink[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s<>"']+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const url = cleanUrl(match[0]);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    const start = Math.max(0, match.index - 160);
    const end = Math.min(text.length, match.index + match[0].length + 160);
    const context = text.slice(start, end);
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const nextNewline = text.indexOf("\n", match.index + match[0].length);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const urlLineContext = text.slice(lineStart, lineEnd);
    if (urlLooksLikeFooterOrTracking(url, urlLineContext)) continue;
    const classified = classifyBuilderLink(urlLineContext || context);
    if (!classified) continue;
    seen.add(key);
    links.push({ ...classified, url, source: "email_body" });
  }

  const labelCounts = new Map<string, number>();
  return links.map((link) => {
    const count = (labelCounts.get(link.label) || 0) + 1;
    labelCounts.set(link.label, count);
    return count === 1 ? link : { ...link, label: `${link.label} ${count}` };
  });
}

function linkFromAny(
  value: unknown,
  source: BuilderEmailLink["source"],
): BuilderEmailLink | null {
  if (!value) return null;
  if (typeof value === "string") {
    const url = cleanUrl(value);
    return url
      ? { label: "Builder Portal", url, kind: "builder_portal", source }
      : null;
  }
  if (isRecord(value)) {
    const url = cleanUrl(
      stringField(value.url) ||
        stringField(value.href) ||
        stringField(value.link) ||
        stringField(value.portal_link) ||
        "",
    );
    if (!url) return null;
    const label = (
      stringField(value.label) ||
      stringField(value.title) ||
      stringField(value.name) ||
      "Builder Portal"
    ).trim() || "Builder Portal";
    const kind = (
      stringField(value.kind) || stringField(value.type) || "builder_portal"
    ).trim() || "builder_portal";
    return { label, url, kind, source };
  }
  return null;
}

export function normalizeReportExternalLinks(
  extraction: ExtractionLike | null | undefined,
): BuilderEmailLink[] {
  const out: BuilderEmailLink[] = [];
  const seen = new Set<string>();
  const add = (candidate: BuilderEmailLink | null) => {
    if (!candidate) return;
    const key = candidate.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  for (
    const link of Array.isArray(extraction?.portal_links)
      ? extraction.portal_links
      : []
  ) {
    add(
      linkFromAny(
        link,
        link?.source === "email_body" ? "email_body" : "claude",
      ),
    );
  }
  add(linkFromAny(extraction?.portal_link, "legacy_portal_link"));
  return out;
}

export function mergeDeterministicAndClaudeLinks(
  deterministic: BuilderEmailLink[],
  claudeExtraction: ExtractionLike | null | undefined,
): BuilderEmailLink[] {
  const byUrl = new Map<string, BuilderEmailLink>();
  for (const link of deterministic || []) {
    byUrl.set(link.url.toLowerCase(), link);
  }
  for (
    const link of Array.isArray(claudeExtraction?.portal_links)
      ? claudeExtraction.portal_links
      : []
  ) {
    const parsed = linkFromAny(link, "claude");
    if (!parsed) continue;
    const key = parsed.url.toLowerCase();
    const existing = byUrl.get(key);
    byUrl.set(
      key,
      existing
        ? {
          ...existing,
          label: parsed.label || existing.label,
          kind: parsed.kind || existing.kind,
        }
        : parsed,
    );
  }
  const legacy = linkFromAny(
    claudeExtraction?.portal_link,
    "legacy_portal_link",
  );
  if (legacy && !byUrl.has(legacy.url.toLowerCase())) {
    byUrl.set(legacy.url.toLowerCase(), legacy);
  }
  return [...byUrl.values()];
}
