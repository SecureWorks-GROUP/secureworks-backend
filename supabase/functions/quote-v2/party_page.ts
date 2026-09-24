// Quote v2 party link page. PROGRAM BRANCH ONLY.
//
// Renders exactly what `quote_v2_open_party_link` returned for ONE party:
// that party's current revision (job total, their share line by line, the
// other parties by first name and split) and their own Accept. It is given
// nothing else, so it cannot show another party's quote, a cost, a markup or
// a contact. Since stage 3 the quote itself is the branded document
// (quote_document.ts); link states with no quote stay plain.
//
// Pure: no network or database.

import {
  type QuoteDocumentView,
  renderQuoteDocumentHtml,
} from "./quote_document.ts";

export interface PartyQuoteView {
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
  expired: boolean;
  job_total: { ex_gst: number; gst: number; inc_gst: number };
  party: {
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
  accepted_at: string | null;
  /** The day the revision was frozen (quote_v2_open_party_document). */
  issued_on?: string;
}

export interface PartyLinkResult {
  state: "current" | "forwarded" | "no_current_quote" | "revoked" | "unknown";
  link_revision_number: number | null;
  quote: PartyQuoteView | null;
}

export { escapeHtml, money } from "./format.ts";
import { escapeHtml, money } from "./format.ts";

function perthDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const STYLE = `
body{margin:0;background:#f6f5f2;color:#1d1d1b;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;margin:0 0 4px}
.muted{color:#5f5e5a;font-size:.9rem}
.card{background:#fff;border:1px solid #e3e1db;border-radius:10px;padding:16px;margin:16px 0}
.notice{background:#fff7e0;border-color:#e8d6a0}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #eee;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}
.total td{font-weight:600;border-bottom:none}
button{background:#1d1d1b;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box;margin:8px 0 12px}
ul{margin:4px 0;padding-left:20px}
`;

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><main>${body}</main>${
    nonce
      ? `<script nonce="${escapeHtml(nonce)}">${ACCEPT_SCRIPT}</script>`
      : ""
  }</body></html>`;
}

// Posts the party's acceptance of exactly the revision and content shown.
// The token never leaves the address bar except to this same function.
const ACCEPT_SCRIPT = `
(function(){
  var t0=new URLSearchParams(location.search).get('t'),p=document.getElementById('pdf');
  if(p&&t0)p.href=location.pathname+'?t='+encodeURIComponent(t0)+'&format=pdf';
  var f=document.getElementById('accept');if(!f)return;
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var b=f.querySelector('button'),m=document.getElementById('accept-msg');
    b.disabled=true;m.textContent='Recording your acceptance...';
    var t=new URLSearchParams(location.search).get('t');
    fetch(location.pathname+'?action=accept',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({t:t,revision_id:f.dataset.revision,content_hash:f.dataset.hash,
        accepted_name:(f.querySelector('input')||{}).value||null})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){
      if(x.ok){m.textContent='Thank you. Your acceptance is recorded.';f.querySelector('input').disabled=true;}
      else{m.textContent=x.j&&x.j.error?x.j.error:'Something went wrong. Please try again.';b.disabled=false;}
    }).catch(function(){m.textContent='Something went wrong. Please try again.';b.disabled=false;});
  });
})();`;

function message(title: string, text: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><div class="card"><p>${
      escapeHtml(text)
    }</p><p class="muted">SecureWorks Group</p></div>`,
    "",
  );
}

export function renderPartyPage(
  result: PartyLinkResult,
  nonce: string,
): { status: number; html: string } {
  if (result.state === "unknown" || result.state === "revoked") {
    return {
      status: 404,
      html: message(
        "Quote link not valid",
        "This quote link is no longer valid. Please contact SecureWorks Group for your current quote.",
      ),
    };
  }
  if (result.state === "no_current_quote" || !result.quote) {
    return {
      status: 200,
      html: message(
        "No current quote",
        "There is no current quote for you on this job. Please contact SecureWorks Group.",
      ),
    };
  }
  const q = result.quote;
  const forwarded = result.state === "forwarded"
    ? `<p class="note"><b>This quote was updated.</b> You are viewing your current quote (revision ${
      escapeHtml(q.revision_number)
    }); the earlier one (revision ${
      escapeHtml(result.link_revision_number)
    }) no longer applies.</p>`
    : "";
  const action = q.accepted_at
    ? `<p style="margin:0"><strong>Accepted</strong> on ${
      escapeHtml(perthDate(q.accepted_at))
    }. Thank you, we will be in touch to confirm your install date.</p>`
    : q.expired
    ? `<p style="margin:0">This quote was valid until ${
      escapeHtml(perthDate(q.valid_until))
    }. Please contact SecureWorks Group for an updated quote.</p>`
    : `<form id="accept" data-revision="${
      escapeHtml(q.revision_id)
    }" data-hash="${
      escapeHtml(q.content_hash)
    }"><p style="margin:0 0 4px"><strong>Ready to go ahead?</strong> Accepting confirms ${
      q.other_parties.length ? "your share of " : ""
    }this quote, exactly as shown.</p><label>Your name<input name="accepted_name" autocomplete="name" maxlength="200"></label><button type="submit">Accept ${
      money(q.party.share.inc_gst)
    } inc GST</button><p id="accept-msg" class="muted" role="status"></p></form>`;
  const panel =
    `${forwarded}<div class="panel">${action}<p class="muted" style="margin:10px 0 0"><a class="btn alt" href="#" id="pdf">Download PDF</a></p></div>`;
  const view: QuoteDocumentView = {
    ...q,
    issued_on: q.issued_on ?? q.valid_until,
  };
  return {
    status: 200,
    html: renderQuoteDocumentHtml(view, {
      beforeIncluded: panel,
      script: nonce ? { nonce, source: ACCEPT_SCRIPT } : undefined,
    }),
  };
}
