// Deterministic MakeSafe report-link extraction from builder email bodies.
// Pure helpers only: no network, no Supabase, no live sends.

export type BuilderEmailLink = {
  label: string;
  url: string;
  kind: string;
  source: "email_body" | "claude" | "legacy_portal_link" | "attachment_text";
};

// Intake item 4 — builder portal / report-share hosts (Prime Eco is the dominant
// one for MLB/Prime roof & assessment reports). A URL on one of these hosts, or any
// URL whose path is a share link, is the crew's report portal and MUST be captured
// even when it sits on a line the generic footer/tracking filter would otherwise
// drop, and even with no descriptive words around it. Recon proof (SWMS-26632):
// primeeco.tech share links lived only in the raw email body and never reached
// makesafe_details.external_links, so the report was invisible to everyone.
const PORTAL_HOST_RE =
  /(^|\.)(primeeco\.tech|primeeco\.[a-z.]+|prime-?eco\.[a-z.]+)$/i;
const PORTAL_PATH_RE = /\/(share|report|reports|portal|s|r)\//i;

export function urlIsBuilderPortalLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (PORTAL_HOST_RE.test(u.hostname)) return true;
    if (/primeeco/i.test(u.hostname)) return true;
    // A share-style path on any host (…/share/<token>) is a report portal link.
    if (PORTAL_PATH_RE.test(u.pathname)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

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

// Exported for the portal-done marker (index.ts): one URL-hygiene routine
// (entity-decode, trailing-punctuation strip, http(s)-only) instead of a
// parallel regex. Returns "" for anything that is not a clean http(s) URL.
export function cleanUrl(url: string): string {
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

// Positive-only kind for a KNOWN builder-portal link: unlike classifyBuilderLink it
// never returns null (a portal link is always kept) and is not vetoed by footer words
// that happen to sit in the same context window as the report link.
function classifyPortalKind(context: string): { label: string; kind: string } {
  const c = context.toLowerCase();
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
  return { label: "Builder portal link", kind: "builder_portal" };
}

export function extractBuilderEmailLinks(
  bodyTextOrHtml: string | null | undefined,
  // Intake item 4 — also scan recovered attachment/PDF text for portal links (a WO
  // PDF sometimes carries the only report share link). Links found here are tagged
  // source:"attachment_text". Empty/undefined is a no-op.
  attachmentText?: string | null | undefined,
): BuilderEmailLink[] {
  const links: BuilderEmailLink[] = [];
  const seen = new Set<string>();

  const scan = (
    raw: string | null | undefined,
    source: BuilderEmailLink["source"],
  ) => {
    const text = stripEmailHtmlForTrade(raw, 20000);
    if (!text) return;
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
      const isPortal = urlIsBuilderPortalLink(url);
      // A recognised builder-portal / share link is ALWAYS captured (never dropped by
      // the footer/tracking filter) and classified by positive signals in the wider
      // context (e.g. "complete the roof report" on the line above) or its own path.
      // Only non-portal links are subject to the footer/tracking reject + veto-classify.
      let classified: { label: string; kind: string } | null;
      if (isPortal) {
        classified = classifyPortalKind(`${context} ${url}`);
      } else {
        if (urlLooksLikeFooterOrTracking(url, urlLineContext)) continue;
        classified = classifyBuilderLink(urlLineContext || context);
        if (!classified) continue;
      }
      seen.add(key);
      links.push({ ...classified, url, source });
    }
  };

  scan(bodyTextOrHtml, "email_body");
  scan(attachmentText, "attachment_text");

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

// Intake item 4 (nudge-email pattern) — idempotently ADD incoming links to a job's
// existing external_links WITHOUT overwriting. Used when a builder "please complete
// the report" nudge (portal link, no new WO PDF) references a ref that already has a
// live job: the link must land on that job, and re-scanning the same nudge must be a
// no-op. Existing entries win (never clobber an operator edit); a URL already present
// is not re-added. Returns the merged list plus exactly which links were newly added.
export function mergeIntoExternalLinks(
  current: unknown,
  incoming: BuilderEmailLink[],
): { links: BuilderEmailLink[]; added: BuilderEmailLink[] } {
  const byUrl = new Map<string, BuilderEmailLink>();
  const order: string[] = [];
  const remember = (link: BuilderEmailLink | null) => {
    if (!link) return false;
    const key = link.url.toLowerCase();
    if (byUrl.has(key)) return false;
    byUrl.set(key, link);
    order.push(key);
    return true;
  };
  // Seed with whatever the job already carries (array of objects/strings, or a bare
  // string), normalised through the same parser used everywhere else.
  const currentArr = Array.isArray(current)
    ? current
    : (current == null ? [] : [current]);
  for (const c of currentArr) remember(linkFromAny(c, "legacy_portal_link"));
  const added: BuilderEmailLink[] = [];
  for (const link of incoming || []) {
    if (remember(link)) added.push(link);
  }
  return { links: order.map((k) => byUrl.get(k)!), added };
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
