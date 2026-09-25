// Quote v2 party link page. PROGRAM BRANCH ONLY.
//
// Renders exactly what `quote_v2_open_party_link` returned for ONE party:
// that party's current revision (job total, their share line by line, the
// other parties by first name and split) and their own Accept. It is given
// nothing else, so it cannot show another party's quote, a cost, a markup or
// a contact. Branded rendering is stage 3; this page is deliberately plain.
//
// Pure: no network or database.

export interface PartyQuoteView {
  revision_id: string;
  revision_number: number;
  content_hash: string;
  job_number: string | null;
  site_suburb: string | null;
  family: string;
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
}

export interface PartyLinkResult {
  state: "current" | "forwarded" | "no_current_quote" | "revoked" | "unknown";
  link_revision_number: number | null;
  quote: PartyQuoteView | null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

export function money(value: number | string): string {
  return AUD.format(Number(value));
}

function qty(value: number | string): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

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
  const place = [q.job_number, q.site_suburb].filter(Boolean).join(", ");
  const scope = q.scope ?? {};
  const list = (items?: string[]) =>
    items?.length
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : "";
  const forwarded = result.state === "forwarded"
    ? `<div class="card notice">This quote was updated. You are viewing your current quote (revision ${
      escapeHtml(q.revision_number)
    }); the earlier one (revision ${
      escapeHtml(result.link_revision_number)
    }) no longer applies.</div>`
    : "";
  const shared = q.other_parties.length > 0;
  const others = shared
    ? `<p>This work is shared: ${
      [
        `you ${q.party.share_of_job_percent}%`,
        ...q.other_parties.map((o) =>
          `${escapeHtml(o.first_name)} ${o.share_of_job_percent}%`
        ),
      ].join(", ")
    }.</p>`
    : "";
  const rows = q.lines.map((l) =>
    `<tr><td>${escapeHtml(l.description)}<div class="muted">${
      escapeHtml(qty(l.qty))
    } ${escapeHtml(l.unit)}</div></td>${
      shared ? `<td class="n">${money(l.line_total_ex_gst)}</td>` : ""
    }<td class="n">${money(l.your_share_ex_gst)}</td></tr>`
  ).join("");
  const accept = q.accepted_at
    ? `<p><strong>Accepted</strong> on ${
      escapeHtml(perthDate(q.accepted_at))
    }. Thank you.</p>`
    : q.expired
    ? `<p>This quote was valid until ${
      escapeHtml(perthDate(q.valid_until))
    }. Please contact SecureWorks Group for an updated quote.</p>`
    : `<form id="accept" data-revision="${
      escapeHtml(q.revision_id)
    }" data-hash="${
      escapeHtml(q.content_hash)
    }"><label>Your name<input name="accepted_name" autocomplete="name" maxlength="200"></label><button type="submit">Accept ${
      money(q.party.share.inc_gst)
    } inc GST</button><p id="accept-msg" class="muted" role="status"></p></form>`;
  const body = `
<h1>${escapeHtml(scope.title || "Your quote")}</h1>
<p class="muted">${escapeHtml(place)}${place ? " &middot; " : ""}Quote for ${
    escapeHtml(q.party.first_name)
  } &middot; revision ${escapeHtml(q.revision_number)} &middot; valid until ${
    escapeHtml(perthDate(q.valid_until))
  }</p>
${forwarded}
<div class="card">
${scope.summary ? `<p>${escapeHtml(scope.summary)}</p>` : ""}
${
    scope.inclusions?.length
      ? `<p><strong>Includes</strong></p>${list(scope.inclusions)}`
      : ""
  }
${
    scope.exclusions?.length
      ? `<p><strong>Not included</strong></p>${list(scope.exclusions)}`
      : ""
  }
${scope.notes ? `<p>${escapeHtml(scope.notes)}</p>` : ""}
${others}
</div>
<div class="card">
<table><thead><tr><th>Item</th>${
    shared ? '<th class="n">Job</th>' : ""
  }<th class="n">${
    shared ? "Your share" : "Amount"
  }</th></tr></thead><tbody>${rows}</tbody>
<tfoot>
${
    shared
      ? `<tr><td>Job total inc GST</td><td class="n">${
        money(q.job_total.inc_gst)
      }</td><td></td></tr>`
      : ""
  }
<tr><td>Your total ex GST</td>${shared ? "<td></td>" : ""}<td class="n">${
    money(q.party.share.ex_gst)
  }</td></tr>
<tr><td>GST</td>${shared ? "<td></td>" : ""}<td class="n">${
    money(q.party.share.gst)
  }</td></tr>
<tr class="total"><td>Your total inc GST</td>${
    shared ? "<td></td>" : ""
  }<td class="n">${money(q.party.share.inc_gst)}</td></tr>
</tfoot></table>
</div>
<div class="card">${accept}</div>
<p class="muted">SecureWorks Group</p>`;
  return {
    status: 200,
    html: page(`Quote ${q.job_number ?? ""}`.trim(), body, nonce),
  };
}
