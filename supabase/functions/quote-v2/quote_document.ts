// Quote v2 stage 3: the customer quote document, rendered on the server from
// ONE party's frozen revision. PROGRAM BRANCH ONLY.
//
// Input is exactly `quote_v2_party_document` (the party view plus the issue
// date): that party's share line by line, the job total, the other parties by
// first name and percentage. It never holds a cost, markup, price source,
// contact or token, so the document cannot show one. The same model feeds the
// HTML here and the PDF in quote_pdf.ts, so both say the same thing.
//
// The look follows the approved quote design (the fence quote skill's
// round-2 design and today's patio quote): slate header with the white logo,
// orange rule, "prepared for", what it costs, the investment panel, what is
// and is not included, how to accept, and the approved fencing terms for
// fencing and Stratco work.
//
// Pure and deterministic: the same view renders the same bytes, so a send
// preview can hash the document the customer will get.

import { escapeHtml, money } from "./format.ts";
import { FENCING_TERMS, LOGO_WHITE_SVG } from "./brand/assets.ts";

export interface QuoteDocumentView {
  revision_id: string;
  revision_number: number;
  content_hash: string;
  job_number: string | null;
  site_suburb: string | null;
  family: "fencing" | "patio" | "stratco" | "misc";
  scope: {
    title?: string;
    summary?: string;
    inclusions?: string[];
    exclusions?: string[];
    notes?: string;
  };
  valid_until: string;
  issued_on: string;
  job_total: { ex_gst: number; gst: number; inc_gst: number };
  party: {
    party_id?: string;
    first_name: string;
    role: "client" | "neighbour";
    share: { ex_gst: number; gst: number; inc_gst: number };
    share_of_job_percent: number;
  };
  lines: {
    description: string;
    qty: number;
    unit: string;
    line_total_ex_gst: number;
    your_share_ex_gst: number;
  }[];
  other_parties: {
    first_name: string;
    role: "client" | "neighbour";
    share_of_job_percent: number;
  }[];
}

export const BRAND = {
  slate: "#1E2B33",
  navy: "#293C46",
  orange: "#F15A29",
  steel: "#4C6A7C",
  ink: "#1D2A31",
  paper: "#FBFAF8",
  line: "#E4DED7",
  soft: "#FDF2EE",
  company: "SecureWorks Group Pty Ltd",
  abn: "64 689 223 416",
  web: "secureworksgroup.com.au",
} as const;

export interface Division {
  phone: string;
  email: string;
}

/** Same routing as the live quote emails: fencing and Stratco screening go
 * to the fencing desk, everything else to patios (send-quote). */
export function divisionFor(family: QuoteDocumentView["family"]): Division {
  return family === "fencing" || family === "stratco"
    ? { phone: "0489 267 772", email: "fencing@secureworkswa.com.au" }
    : { phone: "0489 267 771", email: "patios@secureworkswa.com.au" };
}

export function alsoBuild(family: QuoteDocumentView["family"]): string {
  return family === "patio"
    ? "We also build fencing, decking and sheds"
    : "We also build patios, decking and sheds";
}

export function familyHeading(family: QuoteDocumentView["family"]): string {
  return family === "fencing"
    ? "Your fencing quote"
    : family === "patio"
    ? "Your patio quote"
    : "Your quote";
}

/** The approved fencing terms apply to fencing and Stratco screening. Patio
 * and other work have no approved terms here yet, so none are printed. */
export function termsFor(
  family: QuoteDocumentView["family"],
): readonly (readonly [string, string])[] {
  return family === "fencing" || family === "stratco" ? FENCING_TERMS : [];
}

export function quoteReference(v: QuoteDocumentView): string {
  return `${v.job_number ?? "Quote"} rev ${v.revision_number}`;
}

export function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const UNIT_WORDS: Record<string, [string, string]> = {
  lm: ["m", "m"],
  m2: ["m²", "m²"],
  each: ["", ""],
  item: ["", ""],
  lot: ["lot", "lots"],
  length: ["length", "lengths"],
  stock: ["length", "lengths"],
  hour: ["hour", "hours"],
  day: ["day", "days"],
  bag: ["bag", "bags"],
  delivery: ["", ""],
  job: ["", ""],
};

/** "22 m", "9", "5 bags", "2 lengths"; blank for a single item or lot sum. */
export function quantityText(qty: number | string, unit: string): string {
  const n = Number(qty);
  if (n === 1 && (unit === "item" || unit === "job")) return "";
  const q = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
  const words = UNIT_WORDS[unit];
  const word = words ? (n === 1 ? words[0] : words[1]) : unit;
  return word ? `${q} ${word}` : q;
}

export function isShared(v: QuoteDocumentView): boolean {
  return v.other_parties.length > 0;
}

/** "You pay 50% of the job; Fiona pays 50%." */
export function shareSentence(v: QuoteDocumentView): string {
  const others = v.other_parties.map((o) =>
    `${o.first_name} pays ${o.share_of_job_percent}%`
  );
  return `This work is shared. The whole job is ${
    money(v.job_total.inc_gst)
  } including GST. You pay ${v.party.share_of_job_percent}%; ${
    others.join("; ")
  }.`;
}

/** Terms bodies are the approved HTML (p, ul, li, b only). */
function termsHtml(body: string): string {
  return body.replace(/<(?!\/?(p|ul|li|b)>)[^>]*>/g, "");
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#E9E6E2;color:${BRAND.ink};font:15px/1.55 "Plus Jakarta Sans",-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.doc{max-width:820px;margin:0 auto;background:${BRAND.paper}}
.top{background:${BRAND.slate};color:#fff;padding:22px 28px;display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:4px solid #2C3B44;position:relative}
.top:after{content:"";position:absolute;left:0;bottom:-4px;width:120px;height:4px;background:${BRAND.orange}}
.top svg{height:34px;width:auto;display:block}
.ref{text-align:right;font-size:13px;color:#D6DEE3}
.ref b{color:#fff}
.band{background:${BRAND.navy};color:#fff;padding:26px 28px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.orange};margin:0 0 6px}
.band h1{margin:0;font-size:26px;line-height:1.2}
.body{padding:24px 28px 8px}
.row{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.who{font-size:26px;font-weight:700;color:${BRAND.navy};margin:2px 0}
.muted{color:${BRAND.steel};font-size:13px}
h2{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.orange};margin:22px 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{background:${BRAND.slate};color:#fff;font-size:11px;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:9px 10px}
td{padding:9px 10px;border-bottom:1px solid ${BRAND.line};vertical-align:top}
.n{text-align:right;white-space:nowrap}
.sum{text-align:right;color:${BRAND.steel};font-size:13px;margin:8px 0 0}
.invest{margin:18px 0 0;background:${BRAND.slate};color:#fff;border-left:6px solid ${BRAND.orange};padding:18px 20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.invest .eyebrow{margin:0 0 2px}
.invest .big{font-size:36px;font-weight:700;line-height:1.1}
.invest small{color:#C9D3D9;font-size:12px}
.note{background:${BRAND.soft};border-left:4px solid ${BRAND.orange};padding:10px 14px;margin:14px 0 0;font-size:14px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
ul.sq{list-style:none;padding:0;margin:0}
ul.sq li{position:relative;padding-left:16px;margin:0 0 6px}
ul.sq li:before{content:"";position:absolute;left:0;top:.55em;width:7px;height:7px;background:${BRAND.orange}}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.steps div{border-top:1px solid ${BRAND.line};padding-top:8px;font-size:14px}
.steps b{display:block;color:${BRAND.orange};font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.terms{columns:2;column-gap:28px;font-size:12px;line-height:1.5}
.terms section{break-inside:avoid-column;margin:0 0 12px}
.terms h3{font-size:12px;color:${BRAND.orange};text-transform:uppercase;margin:0 0 4px}
.terms p{margin:0 0 6px}
.terms ul{margin:0 0 6px;padding-left:16px}
.foot{padding:18px 28px 26px;border-top:1px solid ${BRAND.line};margin-top:18px;font-size:12px;color:${BRAND.steel}}
.foot b{color:${BRAND.ink}}
.panel{margin:18px 0 0;background:#fff;border:1px solid ${BRAND.line};border-radius:10px;padding:16px}
.panel button,.btn{background:${BRAND.orange};color:#fff;border:0;border-radius:8px;padding:13px 20px;font:700 16px/1 inherit;cursor:pointer;text-decoration:none;display:inline-block}
.panel button:disabled{opacity:.5;cursor:default}
.panel input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;margin:6px 0 12px}
.btn.alt{background:${BRAND.navy}}
@media (max-width:640px){.top,.band,.body,.foot{padding-left:16px;padding-right:16px}.cols,.steps{grid-template-columns:1fr}.terms{columns:1}.invest .big{font-size:30px}.hide-sm{display:none}}
@media print{body{background:#fff}.panel{display:none}}
`;

export interface DocumentPageOptions {
  /** Extra HTML inside the document, after the investment (the Accept panel,
   * a "this quote was updated" notice). Omitted for the hashed document. */
  beforeIncluded?: string;
  /** A script with a CSP nonce, for the party page. */
  script?: { nonce: string; source: string };
}

export function renderQuoteDocumentHtml(
  v: QuoteDocumentView,
  opts: DocumentPageOptions = {},
): string {
  const div = divisionFor(v.family);
  const ref = quoteReference(v);
  const shared = isShared(v);
  const place = v.site_suburb ? `Site ${v.site_suburb} WA` : "";
  const scope = v.scope ?? {};
  const rows = v.lines.map((l) =>
    `<tr><td>${escapeHtml(l.description)}</td><td class="n">${
      escapeHtml(quantityText(l.qty, l.unit))
    }</td>${
      shared ? `<td class="n hide-sm">${money(l.line_total_ex_gst)}</td>` : ""
    }<td class="n">${money(l.your_share_ex_gst)}</td></tr>`
  ).join("");
  const list = (items: string[]) =>
    `<ul class="sq">${
      items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")
    }</ul>`;
  const included = scope.inclusions?.length
    ? list(scope.inclusions)
    : list(["The work described above, supplied and installed."]);
  const excluded = scope.exclusions?.length
    ? list(scope.exclusions)
    : `<p class="muted">Nothing beyond the work described above.</p>`;
  const terms = termsFor(v.family);
  const body = `
<div class="doc">
<header class="top">${LOGO_WHITE_SVG}<div class="ref"><b>Quote</b> ${
    escapeHtml(ref)
  }<br>Issued ${escapeHtml(longDate(v.issued_on))}</div></header>
<section class="band"><p class="eyebrow">${
    escapeHtml(familyHeading(v.family))
  }</p><h1>${escapeHtml(scope.title || "Your quote")}</h1></section>
<main class="body">
<div class="row"><div><p class="eyebrow">Prepared for</p><div class="who">${
    escapeHtml(v.party.first_name)
  }</div><div>${escapeHtml(place)}</div></div>
<div class="ref muted" style="color:${BRAND.steel}">Quote ${
    escapeHtml(ref)
  }<br>Issued ${escapeHtml(longDate(v.issued_on))}<br>Valid until ${
    escapeHtml(longDate(v.valid_until))
  }</div></div>
${
    scope.summary
      ? `<h2>The work</h2><p style="margin:0">${escapeHtml(scope.summary)}</p>`
      : ""
  }
<h2>What it costs</h2>
<table><thead><tr><th>Item</th><th class="n">Qty</th>${
    shared ? '<th class="n hide-sm">Job ex GST</th>' : ""
  }<th class="n">${
    shared ? "Your share ex GST" : "Amount ex GST"
  }</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sum">${shared ? "Your share ex GST" : "Total ex GST"} ${
    money(v.party.share.ex_gst)
  } &middot; GST ${money(v.party.share.gst)}</p>
<div class="invest"><div><p class="eyebrow">${
    shared ? "Your share" : "Your investment"
  }</p><small>${
    shared
      ? "Your share of the work, including GST"
      : "Quoted work, including GST"
  }</small></div><div style="text-align:right"><div class="big">${
    money(v.party.share.inc_gst)
  }</div><small>Everything described above, installed by our own crew.</small></div></div>
${shared ? `<p class="note">${escapeHtml(shareSentence(v))}</p>` : ""}
<p class="note">This price holds until ${
    escapeHtml(longDate(v.valid_until))
  }. After that date we will need to requote.</p>
${opts.beforeIncluded ?? ""}
<div class="cols"><div><h2>What is included</h2>${included}</div><div><h2>What is not included</h2>${excluded}</div></div>
${
    scope.notes
      ? `<h2>Notes</h2><p style="margin:0">${escapeHtml(scope.notes)}</p>`
      : ""
  }
<h2>Accepting this quote</h2>
<div class="steps"><div><b>Step 1</b>Open your quote link and press Accept, or confirm in writing by email or SMS.</div><div><b>Step 2</b>We confirm your install date in writing and order your materials.</div><div><b>Step 3</b>We build it, then walk the finished work with you.</div></div>
<p class="muted" style="margin-top:12px">Call or text ${
    escapeHtml(div.phone)
  } &middot; Email ${escapeHtml(div.email)} &middot; Quote ${
    escapeHtml(ref)
  }</p>
${
    terms.length
      ? `<h2>Terms and conditions</h2><div class="terms">${
        terms.map(([title, html], i) =>
          `<section><h3>${String(i + 1).padStart(2, "0")} ${
            escapeHtml(title)
          }</h3>${termsHtml(html)}</section>`
        ).join("")
      }</div>`
      : ""
  }
</main>
<footer class="foot"><b>Licensed and insured &middot; Our own crew, not subcontracted &middot; ${
    escapeHtml(alsoBuild(v.family))
  }</b><br>${BRAND.company} &middot; ABN ${BRAND.abn} &middot; ${
    escapeHtml(div.phone)
  } &middot; ${escapeHtml(div.email)} &middot; ${BRAND.web}</footer>
</div>`;
  const script = opts.script
    ? `<script nonce="${
      escapeHtml(opts.script.nonce)
    }">${opts.script.source}</script>`
    : "";
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(`Quote ${ref} - SecureWorks Group`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&amp;display=swap">
<style>${STYLE}</style></head>
<body>${body}${script}</body></html>`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
