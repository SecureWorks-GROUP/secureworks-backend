// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — DETERMINISTIC WO-PDF CLIENT-BLOCK READER (intake item 5)
// ════════════════════════════════════════════════════════════
//
// WHY. Builder "NEW WORK ORDER" emails (MLB / Prime especially) carry the
// homeowner's name + phone ONLY inside the attached work-order PDF, never in the
// email body. So a scan leaves client_name / client_phone null, the draft blocks
// on missing_fields, and it can never become "clean" and auto-approve. This reader
// pulls those fields deterministically from the work-order PDF's recovered text so
// a reviewer no longer has to hand-type them (and a clean draft can flow).
//
// SAFETY POSTURE (this feeds an auto-approval money path, so it is deliberately
// conservative):
//   • Label-anchored only. It reads a value that sits against an explicit label
//     ("Policyholders Name", "Site Address", "Mobile", …). No free-text guessing.
//   • UNAMBIGUOUS ONLY. If the text carries zero — or more than one CONFLICTING —
//     policyholder-name block, it returns nothing and the draft stays manual. A
//     mid-scan mix-up must fail safe, never fill the wrong homeowner onto a job.
//   • Fill-nulls intent. The caller only fills fields that are currently null and
//     tags them PDF-sourced; it never overwrites a value the model already found.
//
// EDGE-SAFE + KEY-LESS. Pure string work on already-recovered PDF text (from
// makesafe_pdf_text.ts — `text` when the model-quality gate passed, else `rawText`).
// It NEVER throws; every failure path returns "nothing found" so intake degrades to
// manual review, never corrupts.
//
// KNOWN LIMIT (documented for the reviewer). Many builder WOs — including today's
// live MLB work orders — are generated with Type0 / Identity-H CID subset fonts
// whose glyphs are only recoverable through a per-font ToUnicode CMap + text-layout
// engine that makesafe_pdf_text.ts intentionally does not run (the recovered text
// layer is just repeated "en-AU" locale tokens). On such a PDF this reader finds no
// labels and correctly returns nothing. It becomes the live client-fill the moment
// a builder ships a text-layer WO, or a ToUnicode decode lands upstream.
//
// LIVE-VERIFIED 2026-07-07 (mission M-A). All 35 live MLB WO PDFs sampled decode to
// EXACTLY `Array(100).fill("en-AU").join(" ")` (599 chars, zero digits/residue), so this
// reader fails closed on every one — it fills nothing and never invents a homeowner.
// What actually makes live MLB WOs born-clean is the PRIMARY model reading the WO as a
// DOCUMENT block (vision): extractPdfText returns mode:'none' on that noise (#294
// looksLikeText gate) so the PDF is handed to the model, which fills client_name/
// site_address/phone before the gate runs. Proof + regression: makesafe_intake_clean_fill_test.ts.

export interface PdfClientFields {
  client_name: string | null;
  client_phone: string | null;
  site_address: string | null;
}

export interface PdfClientFieldsResult {
  /** The fields recovered from the PDF text (null where nothing clean was found). */
  fields: PdfClientFields;
  /** Field names that were actually recovered (subset of the keys of `fields`). */
  found: Array<keyof PdfClientFields>;
  /**
   * True only when a SINGLE, clean policyholder/client block was located. When the
   * text has zero or conflicting client blocks this is false and the caller must
   * keep the draft manual (never auto-promote on an ambiguous read).
   */
  unambiguous: boolean;
  /** Why the read was treated as ambiguous / empty (observability, never thrown). */
  note?: string;
}

// Labels that introduce the homeowner / client name on a builder WO. Ordered by
// specificity; the insurance-builder "Policyholder" wording is the common case.
const NAME_LABELS = [
  "policyholders name",
  "policyholder name",
  "policy holder name",
  "insured name",
  "homeowner name",
  "home owner name",
  "customer name",
  "client name",
];
const ADDRESS_LABELS = [
  "site address",
  "property address",
  "risk address",
  "job address",
];
// Contact / phone labels. "Policyholders Contact" introduces the contact block on
// MLB WOs; "Mobile" is the strongest single phone anchor.
const PHONE_LABELS = [
  "mobile",
  "policyholders contact",
  "policyholder contact",
  "contact number",
  "phone",
];

// Values that are labels/placeholders, not a real name (guards against reading an
// empty "Home:" or the next label as the value).
const LABEL_LIKE =
  /^(policyholder|policy holder|insured|home\s*owner|homeowner|customer|client|site|property|risk|job|insurer|mobile|home|email|contact|phone|name|address|tenant|other|notes?|instructions?)\b/i;

function clean(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/ /g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** A plausible person/company name: has letters, isn't a label, reasonable length. */
function looksLikeName(v: string): boolean {
  const s = clean(v);
  if (s.length < 2 || s.length > 90) return false;
  if (LABEL_LIKE.test(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 2) return false;
  // Overwhelmingly letters/spaces/&/./-/' (allow "Amanda Parker & Mr S. Parker").
  if (!/^[A-Za-z][A-Za-z .,'&/()-]*$/.test(s)) return false;
  return true;
}

/** Normalise an Australian mobile/landline to a bare national number. */
function normalisePhone(raw: string): string | null {
  let d = clean(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+61")) d = "0" + d.slice(3);
  else if (d.startsWith("61") && d.length === 11) d = "0" + d.slice(2);
  d = d.replace(/\D/g, "");
  // Australian mobile (04xxxxxxxx) or 10-digit landline (0x xxxx xxxx).
  if (/^04\d{8}$/.test(d)) return d;
  if (/^0[2-8]\d{8}$/.test(d)) return d;
  return null;
}

function looksLikeAddress(v: string): boolean {
  const s = clean(v);
  if (s.length < 6 || s.length > 140) return false;
  if (LABEL_LIKE.test(s)) return false;
  // A street address: a leading/embedded number plus a street-type word or a
  // comma-separated suburb/state, e.g. "8 Syrinx Pl, Mullaloo, WA 6027".
  const hasNumber = /\d/.test(s);
  const hasStreetWord =
    /\b(st|street|rd|road|ave|avenue|way|ct|court|pl|place|dr|drive|cres|crescent|cl|close|tce|terrace|pde|parade|lane|ln|blvd|loop|rise|view|grove|gardens?|hwy|highway)\b/i
      .test(s);
  const hasStateSuburb = /,\s*[A-Za-z].*\b(wa|nsw|vic|qld|sa|nt|act|tas)\b/i
    .test(s);
  return hasNumber && (hasStreetWord || hasStateSuburb);
}

// Split the text into non-empty, trimmed lines. Works on both the newline-joined
// text-layer output and colon-labelled single lines.
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => clean(l)).filter((l) => l.length > 0);
}

// Read the value that belongs to a label: the text after the colon on the same
// line, else the next non-empty line that is not itself a label-like token.
function valueForLabel(
  ls: string[],
  i: number,
  accept: (v: string) => boolean,
): string | null {
  const line = ls[i];
  const colon = line.indexOf(":");
  if (colon >= 0) {
    const inline = clean(line.slice(colon + 1));
    if (inline && accept(inline)) return inline;
    if (inline) return null; // a value was present on the line but rejected
  } else {
    // "Label" then next line "Value" (the MLB WO layout). Also tolerate a value on
    // the same line after the label words (no colon).
    const afterLabel = clean(line.replace(labelPrefixRe(line), ""));
    if (afterLabel && accept(afterLabel)) return afterLabel;
  }
  // Look at the next up-to-2 non-empty lines for the value.
  for (let j = i + 1; j <= i + 2 && j < ls.length; j++) {
    const cand = ls[j];
    if (!cand) continue;
    if (LABEL_LIKE.test(cand) && !accept(cand)) return null; // hit the next label
    if (accept(cand)) return cand;
    return null;
  }
  return null;
}

function labelPrefixRe(line: string): RegExp {
  // Strip the matched label words from the start of a colon-less "Label Value" line.
  const lower = line.toLowerCase();
  for (const lab of [...NAME_LABELS, ...ADDRESS_LABELS, ...PHONE_LABELS]) {
    if (lower.startsWith(lab)) {
      return new RegExp("^" + lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }
  return /^$/;
}

function findLabelIndices(ls: string[], labels: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < ls.length; i++) {
    const low = ls[i].toLowerCase();
    if (labels.some((lab) => low.startsWith(lab) || low.includes(lab + ":"))) {
      hits.push(i);
    }
  }
  return hits;
}

/**
 * Read client_name / client_phone / site_address from recovered WO PDF text.
 * Deterministic, never throws. Returns unambiguous=false (and empties) when the
 * text has no clean single client block, so the caller keeps the draft manual.
 */
export function extractClientFieldsFromPdfText(
  text: string | null | undefined,
): PdfClientFieldsResult {
  const empty: PdfClientFieldsResult = {
    fields: { client_name: null, client_phone: null, site_address: null },
    found: [],
    unambiguous: false,
  };
  try {
    const t = clean(text);
    if (t.length < 12) return { ...empty, note: "empty" };
    const ls = lines(t);

    // ── client_name — the ambiguity anchor. Collect every distinct name found at a
    // name label; 0 = nothing to fill, >1 conflicting = ambiguous (stay manual).
    const nameIdx = findLabelIndices(ls, NAME_LABELS);
    const names = new Set<string>();
    for (const i of nameIdx) {
      const v = valueForLabel(ls, i, looksLikeName);
      if (v) names.add(clean(v));
    }
    if (names.size === 0) return { ...empty, note: "no_client_name_label" };
    if (names.size > 1) {
      return { ...empty, note: `ambiguous_client_name:${names.size}` };
    }
    const client_name = [...names][0];

    // ── client_phone — prefer a mobile. Scan phone labels; also accept any bare
    // AU mobile in the text if exactly one distinct mobile is present.
    let client_phone: string | null = null;
    const phoneIdx = findLabelIndices(ls, PHONE_LABELS);
    const phones = new Set<string>();
    for (const i of phoneIdx) {
      const v = valueForLabel(ls, i, (x) => normalisePhone(x) !== null);
      const n = v ? normalisePhone(v) : null;
      if (n) phones.add(n);
    }
    // Fall back to a single unambiguous AU mobile anywhere in the block.
    if (phones.size === 0) {
      const mobiles = new Set<string>();
      for (const m of t.matchAll(/(?:\+?61|0)4[\d\s]{8,12}/g)) {
        const n = normalisePhone(m[0]);
        if (n && /^04/.test(n)) mobiles.add(n);
      }
      if (mobiles.size === 1) client_phone = [...mobiles][0];
    } else {
      // Prefer a mobile if present among the labelled phones; else the only one.
      const mob = [...phones].find((p) => /^04/.test(p));
      client_phone = mob ?? (phones.size === 1 ? [...phones][0] : null);
    }

    // ── site_address — read the value at a site-address label if it is a real
    // street address. Single clear hit only.
    let site_address: string | null = null;
    const addrIdx = findLabelIndices(ls, ADDRESS_LABELS);
    const addrs = new Set<string>();
    for (const i of addrIdx) {
      const v = valueForLabel(ls, i, looksLikeAddress);
      if (v) addrs.add(clean(v));
    }
    if (addrs.size === 1) site_address = [...addrs][0];

    const fields: PdfClientFields = { client_name, client_phone, site_address };
    const found = (Object.keys(fields) as Array<keyof PdfClientFields>).filter(
      (k) => fields[k] !== null,
    );
    return { fields, found, unambiguous: true };
  } catch (e) {
    return { ...empty, note: `error:${(e as Error).message}`.slice(0, 120) };
  }
}

// ── Fill policy (the caller-facing decision) ─────────────────────────────────
// Kept here (pure, unit-tested) so the scan / reextract wiring in index.ts is a
// thin call. Enforces: fill NULLS ONLY; never fire on an ambiguous read; only the
// three client fields are touched; confidence may rise medium→high ONLY when the
// read is unambiguous AND the draft is otherwise clean (mirrors the auto-approval
// clean gate's required fields) — never from "low", which signals other problems.

export interface ClientFillInput {
  clientName: string | null;
  clientPhone: string | null;
  siteAddress: string | null;
  confidence: string | null | undefined;
  missingFields: string[];
  externalRefPresent: boolean;
  matchedCompanyPresent: boolean;
}

export interface ClientFillDecision {
  applied: boolean;
  /** Field name → value to write (only fields that were null and got a value). */
  fill: Partial<Record<keyof PdfClientFields, string>>;
  /** Names of the fields filled (for the pdf_sourced tag + missing-field clearing). */
  filledFields: Array<keyof PdfClientFields>;
  /** missingFields with the freshly-filled client fields removed. */
  missingFields: string[];
  /** Possibly-upgraded confidence (unchanged unless the bump conditions hold). */
  confidence: string;
  /** Read diagnostics (unambiguous flag + note) for logging / tests. */
  read: PdfClientFieldsResult;
}

const CLIENT_MISSING_ALIASES: Record<keyof PdfClientFields, string[]> = {
  client_name: [
    "client_name",
    "clientname",
    "customer_name",
    "homeowner",
    "name",
  ],
  client_phone: [
    "client_phone",
    "clientphone",
    "phone",
    "contact_number",
    "mobile",
  ],
  site_address: ["site_address", "siteaddress", "address", "property_address"],
};

export function decidePdfClientFill(
  text: string | null | undefined,
  input: ClientFillInput,
): ClientFillDecision {
  const confidence = String(input.confidence ?? "low").trim().toLowerCase();
  const base: ClientFillDecision = {
    applied: false,
    fill: {},
    filledFields: [],
    missingFields: input.missingFields,
    confidence,
    read: extractClientFieldsFromPdfText(text),
  };
  if (!base.read.unambiguous) return base;

  const current: PdfClientFields = {
    client_name: input.clientName,
    client_phone: input.clientPhone,
    site_address: input.siteAddress,
  };
  const fill: Partial<Record<keyof PdfClientFields, string>> = {};
  const filledFields: Array<keyof PdfClientFields> = [];
  for (const k of Object.keys(current) as Array<keyof PdfClientFields>) {
    const val = base.read.fields[k];
    if (current[k] == null && val != null) {
      fill[k] = val;
      filledFields.push(k);
    }
  }
  if (filledFields.length === 0) return base;

  // Drop the filled client fields from missing_fields (normalised comparison).
  const norm = (s: string) =>
    String(s || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const filledAliases = new Set<string>();
  for (const f of filledFields) {
    for (const a of CLIENT_MISSING_ALIASES[f]) filledAliases.add(a);
  }
  const missingFields = input.missingFields.filter(
    (m) => !filledAliases.has(norm(m)),
  );

  // Confidence bump — conservative. Only medium→high, only when the read is
  // unambiguous AND every clean-gate client field is now present.
  const nameOk = current.client_name != null || fill.client_name != null;
  const addrOk = current.site_address != null || fill.site_address != null;
  let outConfidence = confidence;
  if (
    confidence === "medium" && nameOk && addrOk &&
    input.externalRefPresent && input.matchedCompanyPresent
  ) {
    outConfidence = "high";
  }

  return {
    applied: true,
    fill,
    filledFields,
    missingFields,
    confidence: outConfidence,
    read: base.read,
  };
}
