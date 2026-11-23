// The builder's work order as words a trade may read (owner, 22 Nov 2026).
//
// A trade never opens a builder work order PDF: it can carry the builder's
// prices (the money rule of 23 Sep 2026). But the work order is where the
// instructions are, so trade_job_detail sends this instead: the text the PDF
// reader already extracted, with every money line taken out and the builder's
// terms cut off. It reads email_attachments only. It writes nothing.
//
// A money line is dropped whole. A scope line that only mentions a rate
// ("3 technicians at $60 per hour - lift carpet, strip linings") keeps its
// words and loses the figure, because the words are the scope of works. A
// line that still shows a dollar sign after that is dropped.
// deno-lint-ignore-file no-explicit-any

export const TRADE_WORK_ORDER_BRIEF_MAX = 2400;

// The builder's terms start here. Nothing after it is an instruction.
const STOP_LINE =
  /^(please note|code of conduct|terms and conditions|by accepting this offer)/i;

// A line that is only money: it starts with the money word.
const MONEY_LABEL_LINE =
  /^(sub\s?totals?|totals?|gst|cost|costs|dal|excess|limit|price|amount|rate)\b/i;

// Hours at a rate with no dollar sign ("3 hours at 90").
const HOURS_AT_RATE = /\b(hours?|hrs?)\b.*(@|\bat\b|\bx\b)\s*\d/i;

// A figure inside a sentence, with the "at" before it and the "per hour" after.
const MONEY_PHRASE =
  /\s*(?:\bat\b|@)?\s*\(?\s*(?:AUD\s*)?\$\s?\d[\d,]*(?:\.\d+)?k?(?:\s*(?:\+|inc\.?|ex\.?|incl\.?)\s*GST)?(?:\s*(?:per|\/)\s*[a-z0-9]+(?:\s*,\s*per\s+[a-z0-9]+)?)?\s*\)?/gi;

// The builder's own footer (company numbers, page marks).
const FOOTER_LINE =
  /\b(abn|acn)\b|builder reg|page \d+ of \d+|po box|\be:\s*\S+@|\bt:\s*\(?0\d/i;

export function buildTradeWorkOrderBrief(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (STOP_LINE.test(line)) break;
    if (FOOTER_LINE.test(line)) continue;
    if (MONEY_LABEL_LINE.test(line) || HOURS_AT_RATE.test(line)) continue;
    const words = line.replace(MONEY_PHRASE, " ").replace(/\s+/g, " ")
      .replace(/^[\s\-:,.]+|[\s\-:,]+$/g, "").trim();
    if (!words || words.includes("$") || !/[a-z]{2}/i.test(words)) continue;
    if (kept.length && kept[kept.length - 1] === words) continue;
    kept.push(words);
  }
  let out = kept.join("\n");
  if (out.length > TRADE_WORK_ORDER_BRIEF_MAX) {
    out = out.slice(0, TRADE_WORK_ORDER_BRIEF_MAX).replace(/\n[^\n]*$/, "") +
      "\n(More on the work order. Ask the office.)";
  }
  return out;
}

export type TradeWorkOrderBriefItem = {
  /** What the item is: a task heading or a piece of equipment. */
  title: string;
  /** "2 technicians", when the builder said how many. */
  crew?: string;
  /** "3, for 5 days", when the builder gave a quantity. */
  qty?: string;
  /** The steps under the heading, one per line. */
  lines: string[];
};

export type TradeWorkOrderBriefLayout = {
  facts: Array<{ label: string; value: string }>;
  items: TradeWorkOrderBriefItem[];
};

export type TradeWorkOrderBrief = {
  document_id: string;
  file_name: string | null;
  text: string;
  /** The same words laid out to read; absent when the layout is not recognised. */
  layout?: TradeWorkOrderBriefLayout;
};

const NOTES_MARK = /^notes\s*\/?\s*instructions:?$/i;
const LAYOUT_SKIP = [
  /^[A-Z]{2,5}-\d+PO-\d+$/i, // the work order number on its own line
  /^(restoration|make ?safe|repairs?|allocation work order|additional|work order)$/i,
  /\s-\sto be completed$/i,
  /\bpty ltd$/i,
  /^\d+\s.+\b(WA|NSW|VIC|QLD|SA|NT|TAS|ACT)\s\d{4}$/,
  /^cu\s*-\s*comm\b/i,
];

function splitSteps(text: string): string[] {
  return text.split(/\s+-\s+/).map((t) => t.trim().replace(/^[-:]\s*/, "")).filter(Boolean);
}

/**
 * Lays a brief out to read: a few facts from the builder's header, then one
 * item per task or piece of equipment. Works on the brief's own words, which
 * already carry no money, and adds none. Returns null when the builder's
 * layout is not the one it knows, so the caller shows the plain text.
 */
export function layoutTradeWorkOrderBrief(brief: string): TradeWorkOrderBriefLayout | null {
  const lines = String(brief || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const mark = lines.findIndex((l) => NOTES_MARK.test(l));
  if (mark < 0) return null;
  const head = lines.slice(0, mark);
  const facts: Array<{ label: string; value: string }> = [];
  const fact = (label: string, value: string | undefined) => {
    const v = String(value || "").trim();
    if (v) facts.push({ label, value: v });
  };
  for (const l of head) {
    let m = l.match(/Work Order Number\s+(\S+)/i);
    if (m) fact("Builder work order", m[1]);
    m = l.match(/\bDate\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (m) fact("Issued", m[1]);
    m = l.match(/Supervisor Name\s+(.+?)\s+Supervisor Contact\s*(.*)$/i);
    if (m) fact("Builder supervisor", [m[1], m[2]].map((x) => x.trim()).filter(Boolean).join(", "));
    m = l.match(/Insurer Name\s+(.+)$/i);
    if (m) fact("Insurer", m[1]);
  }

  type Draft = { title: string; text: string; qty: string; days: string; labour: boolean };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const open = (title: string, labour = false) => {
    cur = { title, text: "", qty: "", days: "", labour };
    drafts.push(cur);
  };
  const body = lines.slice(mark + 1).filter((l) => !LAYOUT_SKIP.some((re) => re.test(l)));
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const next = body[i + 1] || "";
    let m = l.match(/^(.+?)\s-\sLabour Rate$/i);
    if (m) { open("", true); continue; }
    m = l.match(/^Equipment\s-\s(.+?)(?:\s*\(per day\))?$/i);
    if (m) { open(m[1].replace(/\s-\s/g, ", ")); continue; }
    m = l.match(/^Qty:\s*(\d+(?:\.\d+)?)(?:\s+Days:\s*(\d+))?$/i);
    if (m) {
      if (!cur) open("Item");
      cur!.qty = m[1];
      if (m[2]) cur!.days = m[2];
      continue;
    }
    m = l.match(/^Days:\s*(\d+)$/i);
    if (m) { if (cur) (cur as Draft).days = m[1]; continue; }
    const c = cur as Draft | null;
    // A line followed by a quantity names a new item; so does one after an
    // item that already has its quantity. Anything else carries the item on.
    if (/^(qty|days):/i.test(next) || !c || c.qty || c.days || (!c.labour && c.text === "" && c.title && /[.:]$/.test(c.title))) {
      open(l);
    } else {
      c.text = c.text ? c.text + " " + l : l;
    }
  }

  const items: TradeWorkOrderBriefItem[] = [];
  for (const d of drafts) {
    let text = d.text.trim();
    let crew = "";
    const cm = text.match(/^(\d+)\s*x\s+Qualified Technician(?:'s|s)?\s*/i);
    if (cm) {
      crew = cm[1] + (cm[1] === "1" ? " technician" : " technicians");
      text = text.slice(cm[0].length).trim();
    }
    let title = d.title;
    let steps = text ? splitSteps(text) : [];
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    if (!title) {
      if (steps.length > 1) {
        // A short first part is the builder's heading ("Hallway and Bathroom").
        title = words(steps[0]) <= 4 ? steps.shift() as string : "Works";
      } else {
        const one = steps[0] || "";
        const colon = one.match(/^([^:]{2,60}):\s+(.+)$/);
        if (colon && words(colon[1]) <= 8) { title = colon[1]; steps = [colon[2]]; }
        else { title = one || "Labour"; steps = []; }
      }
    }
    if (!title && !steps.length) continue;
    const qty = d.qty ? d.qty + (d.days ? `, for ${d.days} days` : "") : (d.days ? `${d.days} days` : "");
    const item: TradeWorkOrderBriefItem = { title, lines: steps };
    if (crew) item.crew = crew;
    if (qty) item.qty = qty;
    items.push(item);
  }
  if (!items.length) return null;
  return { facts, items };
}

function shaOf(doc: any): string {
  const m = String(doc?.storage_url || doc?.pdf_url || "").match(
    /sha256-([0-9a-f]{64})/i,
  );
  return m ? m[1].toLowerCase() : "";
}

/**
 * One brief per work order document on the job that has readable text.
 * A failed read answers an empty list and logs: the job still opens.
 */
export async function readTradeWorkOrderBriefs(
  client: any,
  documents: readonly any[] | null | undefined,
): Promise<TradeWorkOrderBrief[]> {
  const docs = (documents || []).filter((d) =>
    d && d.type === "work_order" && d.id
  ).slice(0, 10);
  if (!docs.length) return [];
  const shas = [...new Set(docs.map(shaOf).filter(Boolean))];
  const names = [
    ...new Set(
      docs.filter((d) => !shaOf(d) && d.file_name).map((d) =>
        String(d.file_name)
      ),
    ),
  ];
  const rows: any[] = [];
  try {
    if (shas.length) {
      const { data, error } = await client.from("email_attachments")
        .select("sha256, name, pdf_extraction_text")
        .in("sha256", shas).not("pdf_extraction_text", "is", null).limit(40);
      if (error) throw error;
      rows.push(...(data || []));
    }
    if (names.length) {
      const { data, error } = await client.from("email_attachments")
        .select("sha256, name, pdf_extraction_text")
        .in("name", names).not("pdf_extraction_text", "is", null).limit(40);
      if (error) throw error;
      rows.push(...(data || []));
    }
  } catch (e) {
    console.error(
      "[ops-api] trade work order brief read failed:",
      (e as Error)?.message,
    );
    return [];
  }
  const out: TradeWorkOrderBrief[] = [];
  for (const doc of docs) {
    const sha = shaOf(doc);
    const row = sha
      ? rows.find((r) => String(r.sha256 || "").toLowerCase() === sha)
      : rows.find((r) => r.name === doc.file_name);
    const text = buildTradeWorkOrderBrief(row?.pdf_extraction_text);
    if (text) {
      const layout = layoutTradeWorkOrderBrief(text);
      out.push({
        document_id: String(doc.id),
        file_name: doc.file_name || null,
        text,
        ...(layout ? { layout } : {}),
      });
    }
  }
  return out;
}
