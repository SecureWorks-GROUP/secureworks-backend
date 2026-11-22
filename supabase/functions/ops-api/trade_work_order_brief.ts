// The builder's work order as words a trade may read (owner, 22 Nov 2026).
//
// A trade never opens a builder work order PDF: it can carry the builder's
// prices (the money rule of 23 Sep 2026). But the work order is where the
// instructions are, so trade_job_detail sends this instead: the text the PDF
// reader already extracted, with every money line taken out and the builder's
// terms cut off. It reads email_attachments only. It writes nothing.
//
// A line is dropped, never rewritten, so a figure cannot survive in part.
// deno-lint-ignore-file no-explicit-any

export const TRADE_WORK_ORDER_BRIEF_MAX = 1800;

// The builder's terms start here. Nothing after it is an instruction.
const STOP_LINE =
  /^(please note|code of conduct|terms and conditions|by accepting this offer)/i;

// Any line that names money goes: a dollar sign, a total, a limit, a rate.
const MONEY_LINE =
  /\$|\b(sub\s?totals?|totals?|gst|dal|excess|rates?|prices?|amounts?|limits?|inc\.?\s?gst|ex\.?\s?gst)\b|\b(hours?|hrs?)\b.*(@|\bat\b|\bx\b)\s*\d/i;

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
    if (MONEY_LINE.test(line) || FOOTER_LINE.test(line)) continue;
    if (kept.length && kept[kept.length - 1] === line) continue;
    kept.push(line);
  }
  let out = kept.join("\n");
  if (out.length > TRADE_WORK_ORDER_BRIEF_MAX) {
    out = out.slice(0, TRADE_WORK_ORDER_BRIEF_MAX).replace(/\n[^\n]*$/, "") +
      "\n(More on the work order. Ask the office.)";
  }
  return out;
}

export type TradeWorkOrderBrief = {
  document_id: string;
  file_name: string | null;
  text: string;
};

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
      out.push({
        document_id: String(doc.id),
        file_name: doc.file_name || null,
        text,
      });
    }
  }
  return out;
}
