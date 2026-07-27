// Deterministic MakeSafe report-link extraction from builder email bodies.
// Pure helpers only: no network, no Supabase, no live sends.

export type BuilderEmailLink = {
  label: string;
  url: string;
  kind: string;
  source: "email_body" | "claude" | "legacy_portal_link" | "attachment_text";
  // W3-F — set ONLY when a report-portal link was captured but its specific type
  // (assessment_report / photos / quote / roof_report) could not be determined from any
  // signal (anchor text, own line, heading above, URL path, sibling triad). The link is
  // kept as generic `builder_portal` — never guessed — and this marker lets the renderer
  // completeness floor + the portal recheck queue see "link present but untyped" instead
  // of silence. Absent on any confidently-typed link. Additive: read side ignores it.
  evidence_gap?: string;
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

// W3-F — canonical link-kind vocabulary the extractor WRITES. The read side (renderer,
// drain_portal_recheck, board audit) stays tolerant to hyphen/underscore/space and to
// aliases, but every write is normalised through here so a stored kind is always one of
// these — `photos`, never `photo_schedule`; `quote`, never `quotation`. Unknown/empty
// falls to the generic bucket (never invent a type).
export const CANON_LINK_KINDS = [
  "roof_report",
  "assessment_report",
  "photos",
  "quote",
  "builder_portal",
] as const;

export function canonicalizeKind(kind: string | null | undefined): string {
  const k = String(kind || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!k) return "builder_portal";
  if (k === "roof_report" || /^roof/.test(k)) return "roof_report";
  if (
    k === "assessment_report" || k.startsWith("assessment") || k === "assess" ||
    k === "assessment_report_quote" || k === "inspection"
  ) return "assessment_report";
  if (
    k === "quote" || k === "quotation" || k === "estimate" ||
    k.startsWith("quote") || k === "scope" || k === "scope_of_works" ||
    k === "scope_quote" || k === "quote_scope"
  ) {
    return "quote";
  }
  if (
    k === "photos" || k === "photo" || k === "photo_schedule" ||
    k === "photoschedule" || k === "photo_report" || k === "photo_evidence" ||
    k === "site_photos" || k === "images" || k === "image" || k === "gallery"
  ) return "photos";
  // Everything else (builder_portal / portal / report / unknown_report / builder / a
  // kind we don't recognise) is the honest generic bucket.
  return "builder_portal";
}

const KIND_LABEL: Record<string, string> = {
  roof_report: "Roof report link",
  assessment_report: "Assessment report link",
  quote: "Scope / quote link",
  photos: "Photo/report portal link",
  builder_portal: "Builder portal link",
};

// A specific link-kind from a free-text signal (anchor text, the URL's own line, the
// heading line above it). Returns null when NO type keyword is present so the caller can
// decide generic-or-flag rather than guess. Order matters: roof outranks assessment (a
// "roof assessment" is a roof report); quote before the generic photo net.
function kindFromText(
  text: string | null | undefined,
): { label: string; kind: string } | null {
  const c = String(text || "").toLowerCase();
  if (!c.trim()) return null;
  if (/\broof\b|roof[_\-\s]?report|roofing/.test(c)) {
    return { label: KIND_LABEL.roof_report, kind: "roof_report" };
  }
  if (/scope of works|scope-of-works|\bscope(?:\s+link)?\b/.test(c)) {
    return { label: KIND_LABEL.quote, kind: "quote" };
  }
  if (/assessment|\bassess\b|inspection|\binspect\b/.test(c)) {
    return { label: KIND_LABEL.assessment_report, kind: "assessment_report" };
  }
  if (/quote|quotation|estimate|pricing/.test(c)) {
    return { label: KIND_LABEL.quote, kind: "quote" };
  }
  if (/photo|photos|\bimages?\b|gallery|pictures?/.test(c)) {
    return { label: KIND_LABEL.photos, kind: "photos" };
  }
  return null;
}

// A specific kind from the URL's DESCRIPTIVE path segments only — never the opaque share
// token (…/share/<uuid> carries no type, which is exactly why the four live cards
// degraded). primeeco share links have no descriptive path, so this returns null for
// them and typing must come from anchor/line/sibling signals.
function kindFromUrlPath(url: string): { label: string; kind: string } | null {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (_) {
    return null;
  }
  // The generic share/report/portal path tokens are NOT type signals (every kind uses
  // them); only look at the descriptive segments.
  if (/roof/.test(path)) {
    return { label: KIND_LABEL.roof_report, kind: "roof_report" };
  }
  if (/assess|inspect/.test(path)) {
    return { label: KIND_LABEL.assessment_report, kind: "assessment_report" };
  }
  if (/quote|quotation|estimate|scope/.test(path)) {
    return { label: KIND_LABEL.quote, kind: "quote" };
  }
  if (/photo|images?|gallery/.test(path)) {
    return { label: KIND_LABEL.photos, kind: "photos" };
  }
  return null;
}

// W3-F — the single strongest signal recovery: map each <a href="URL">ANCHOR</a> to its
// visible anchor text, read from the RAW html BEFORE stripEmailHtmlForTrade flattens the
// document. The flatten drops the anchor's semantic proximity (it rewrites the opening
// <a> tag to a bare URL), so a labelled Prime triad — "View Assessment Report" /
// "Photos" / "View Quote" — collapsed to indistinguishable share links. The builder
// literally names each artifact in the anchor, so this is the highest-priority signal.
// Keyed by cleanUrl(href); tolerant of nested tags inside the anchor and both quote
// styles; first non-empty anchor for a URL wins.
export function extractAnchorTextMap(
  rawHtmlOrText: string | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const raw = String(rawHtmlOrText || "");
  if (!raw) return map;
  const re =
    /<a\b[^>]*?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const url = cleanUrl(m[1]);
    if (!url) continue;
    const key = url.toLowerCase();
    if (map.has(key)) continue;
    const anchorText = decodeEmailHtmlEntitiesForTest(
      m[2].replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ").trim();
    if (anchorText) map.set(key, anchorText);
  }
  return map;
}

// Type a link from all available signals, in strict priority order, first hit wins,
// never guessing: the builder's own anchor label → the URL's descriptive path → the
// link's own line → the heading line immediately above a bare link. The wide ±160-char
// window is deliberately NOT consulted for typing — in a stacked triad it bleeds a
// sibling's label onto the wrong link, which is the degradation this task fixes.
function classifyLinkBySignals(sig: {
  anchorText: string;
  url: string;
  urlLineContext: string;
  prevLine: string;
}): { label: string; kind: string } | null {
  return kindFromText(sig.anchorText) ||
    kindFromUrlPath(sig.url) ||
    kindFromText(sig.urlLineContext) ||
    kindFromText(sig.prevLine);
}

// W3-F — sibling/triad completion. A Prime report email is conventionally a triad:
// assessment report + photos + quote. When a scan yields EXACTLY three portal links and
// two are already typed to two DISTINCT triad roles, the third is determined by
// elimination — not guessed — so an untyped middle link between a typed report and a
// typed quote is filled as photos and its evidence-gap flag cleared. Any weaker shape
// (fewer than two typed, a roof member, more/less than three links) is left alone: a
// flagged generic is better than a wrong type.
const TRIAD_ROLES = ["assessment_report", "photos", "quote"] as const;
function inferTriadFromSiblings(
  portalLinks: BuilderEmailLink[],
): void {
  if (portalLinks.length !== 3) return;
  const typed = portalLinks.filter((l) =>
    canonicalizeKind(l.kind) !== "builder_portal"
  );
  const generic = portalLinks.filter((l) =>
    canonicalizeKind(l.kind) === "builder_portal"
  );
  if (typed.length !== 2 || generic.length !== 1) return;
  const typedKinds = new Set(typed.map((l) => canonicalizeKind(l.kind)));
  // Both typed members must be DISTINCT triad roles, leaving exactly one triad role open.
  if (typedKinds.size !== 2) return;
  if (
    ![...typedKinds].every((k) =>
      (TRIAD_ROLES as readonly string[]).includes(k)
    )
  ) return;
  const missing = TRIAD_ROLES.filter((k) => !typedKinds.has(k));
  if (missing.length !== 1) return;
  const g = generic[0];
  g.kind = missing[0];
  g.label = KIND_LABEL[missing[0]] || g.label;
  delete g.evidence_gap;
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

  // Anchor text lives in the RAW html (the strip flattens <a> to a bare URL), so build
  // the URL→anchor map from the un-stripped inputs first — anchor text is the strongest
  // type signal.
  const anchorMap = new Map<string, string>();
  for (const raw of [bodyTextOrHtml, attachmentText]) {
    for (const [k, v] of extractAnchorTextMap(raw)) {
      if (!anchorMap.has(k)) anchorMap.set(k, v);
    }
  }

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
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const nextNewline = text.indexOf("\n", match.index + match[0].length);
      const lineEnd = nextNewline === -1 ? text.length : nextNewline;
      const urlLineContext = text.slice(lineStart, lineEnd);
      // The heading line immediately ABOVE a bare link — Prime stacks a label line then
      // the URL on its own line, so this is a real, contamination-free signal.
      const prevLineEnd = lineStart > 0 ? lineStart - 1 : 0;
      const prevLineStart = lineStart > 0
        ? text.lastIndexOf("\n", prevLineEnd - 1) + 1
        : 0;
      const prevLineRaw = lineStart > 0
        ? text.slice(prevLineStart, prevLineEnd)
        : "";
      // Only trust the line above as a heading label when it is NOT itself a link line —
      // a stacked sibling link ("Quote: https://…") must never bleed its type onto the
      // bare link below it.
      const prevLine = /https?:\/\//i.test(prevLineRaw) ? "" : prevLineRaw;
      const anchorText = anchorMap.get(key) || "";
      const isPortal = urlIsBuilderPortalLink(url);

      const classified = classifyLinkBySignals({
        anchorText,
        url,
        urlLineContext,
        prevLine,
      });

      if (isPortal) {
        // A recognised report-share link is ALWAYS captured (never dropped by the
        // footer/tracking filter). Typed if any signal named it; otherwise kept generic
        // and flagged as an evidence gap — never guessed.
        seen.add(key);
        links.push(
          classified ? { ...classified, url, source } : {
            label: KIND_LABEL.builder_portal,
            kind: "builder_portal",
            url,
            source,
            evidence_gap:
              "portal link captured but type undetermined (no anchor/line/path/sibling signal)",
          },
        );
        continue;
      }

      // Non-portal link: reject footer/tracking first (unchanged), then type it; a
      // surviving builder link with no type signal is kept as flagged generic.
      if (urlLooksLikeFooterOrTracking(url, urlLineContext)) continue;
      seen.add(key);
      links.push(
        classified ? { ...classified, url, source } : {
          label: KIND_LABEL.builder_portal,
          kind: "builder_portal",
          url,
          source,
          evidence_gap: "builder link captured but type undetermined",
        },
      );
    }
  };

  scan(bodyTextOrHtml, "email_body");
  scan(attachmentText, "attachment_text");

  // Sibling/triad completion over the portal links, in scan order.
  inferTriadFromSiblings(links.filter((l) => urlIsBuilderPortalLink(l.url)));

  const labelCounts = new Map<string, number>();
  return links.map((link) => {
    const canonical: BuilderEmailLink = {
      ...link,
      kind: canonicalizeKind(link.kind),
    };
    const count = (labelCounts.get(canonical.label) || 0) + 1;
    labelCounts.set(canonical.label, count);
    return count === 1
      ? canonical
      : { ...canonical, label: `${canonical.label} ${count}` };
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
    const kind = canonicalizeKind(
      stringField(value.kind) || stringField(value.type) || "builder_portal",
    );
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

// The auto-assigned generic labels — an entry carrying one of these is untyped system
// output, safe to relabel on upgrade; any other label is treated as operator prose and
// preserved.
const DEFAULT_GENERIC_LABELS = new Set([
  "builder portal",
  "builder portal link",
  "portal report",
  "",
]);
function isDefaultGenericLabel(label: string | null | undefined): boolean {
  return DEFAULT_GENERIC_LABELS.has(String(label || "").trim().toLowerCase());
}

// Intake item 4 (nudge-email pattern) — idempotently ADD incoming links to a job's
// existing external_links WITHOUT overwriting. Used when a builder "please complete
// the report" nudge (portal link, no new WO PDF) references a ref that already has a
// live job: the link must land on that job, and re-scanning the same nudge must be a
// no-op. Existing entries win (never clobber an operator edit); a URL already present
// is not re-added — EXCEPT a generic/untyped existing entry is UPGRADED in place to the
// incoming specific type (a re-scan by the hardened extractor now knows what the link
// is). This is an idempotent upgrade, not a duplicate: same URL, same slot/order, kind
// sharpened and the evidence-gap flag cleared, an operator's custom label kept. Returns
// the merged list, the newly-added links, and the in-place upgrades.
export function mergeIntoExternalLinks(
  current: unknown,
  incoming: BuilderEmailLink[],
): {
  links: BuilderEmailLink[];
  added: BuilderEmailLink[];
  upgraded: BuilderEmailLink[];
} {
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
  const upgraded: BuilderEmailLink[] = [];
  for (const raw of incoming || []) {
    if (!raw) continue;
    const link: BuilderEmailLink = { ...raw, kind: canonicalizeKind(raw.kind) };
    const key = link.url.toLowerCase();
    const existing = byUrl.get(key);
    if (!existing) {
      if (remember(link)) added.push(link);
      continue;
    }
    // Same URL already present: idempotent by default (existing wins), except upgrade a
    // generic/untyped existing entry to the incoming specific type.
    const existingGeneric =
      canonicalizeKind(existing.kind) === "builder_portal";
    const incomingSpecific = link.kind !== "builder_portal";
    if (existingGeneric && incomingSpecific) {
      const upgradedLink: BuilderEmailLink = {
        ...existing,
        kind: link.kind,
        label: isDefaultGenericLabel(existing.label)
          ? link.label
          : existing.label,
      };
      delete upgradedLink.evidence_gap;
      byUrl.set(key, upgradedLink);
      upgraded.push(upgradedLink);
    }
  }
  return { links: order.map((k) => byUrl.get(k)!), added, upgraded };
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
    if (!existing) {
      byUrl.set(key, parsed);
      continue;
    }
    // Claude names a type the deterministic pass left generic → sharpen the kind and
    // clear the evidence-gap flag; otherwise keep the deterministic (specific) kind.
    const parsedSpecific = parsed.kind !== "builder_portal";
    const merged: BuilderEmailLink = {
      ...existing,
      label: parsed.label || existing.label,
      kind: parsedSpecific ? parsed.kind : existing.kind,
    };
    if (canonicalizeKind(merged.kind) !== "builder_portal") {
      delete merged.evidence_gap;
    }
    byUrl.set(key, merged);
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
