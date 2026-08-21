const PDF_SCOPE_START_RE =
  /^(?:(?:additional|special)\s+)?(?:notes?\s*\/\s*)?instructions?\s*:?\s*(.*)$|^scope(?:\s+of\s+works?)?\s*:?\s*(.*)$|^(?:works?|job)\s+description\s*:?\s*(.*)$|^makesafe\s*\/\s*emergency\s+repairs?\b\s*(.*)$/i;
const PDF_SCOPE_STOP_RE =
  /^(?:totals?|subtotal|work\s+order\s+terms(?:\s+and\s+conditions)?|period\s+trade\s+contract\s+conditions|conditions|please\s+forward\s+all\s+invoices|bill\s+to:|major\s+lb\s+pty|secure\s+works\s+wa|yours\s+sincerely)\b/i;
const PDF_SCOPE_MAX_LINES = 25;
const PDF_SCOPE_MAX_CHARS = 4_000;

function clean(value: unknown): string | null {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function isAjsBuilder(builder: string | null | undefined): boolean {
  const key = String(builder || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "aj" || key === "ajs" || key === "ajbr" ||
    key === "ajsajbr";
}

export function scopeBlockFromPdfText(
  rawText: string | null | undefined,
  builder?: string | null,
): string {
  const lines = String(rawText || "").split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const starts = lines.flatMap((line, index) =>
    PDF_SCOPE_START_RE.test(line) ? [index] : []
  );
  if (!starts.length && isAjsBuilder(builder)) {
    const makeSafeHeading = lines.findIndex((line) =>
      /^make\s*-?\s*safe$/i.test(line)
    );
    if (makeSafeHeading >= 0) starts.push(makeSafeHeading);
  }
  if (!starts.length) return "";
  const blocks: string[] = [];
  for (const start of starts) {
    const startMatch = lines[start].match(PDF_SCOPE_START_RE);
    const inline = clean(
      startMatch?.slice(1).find((value) => clean(value)) || "",
    );
    const block = inline ? [inline] : [];
    for (
      let index = start + 1;
      index < lines.length && block.length < PDF_SCOPE_MAX_LINES;
      index++
    ) {
      const line = lines[index];
      if (PDF_SCOPE_STOP_RE.test(line)) break;
      if (index !== start + 1 && PDF_SCOPE_START_RE.test(line)) break;
      block.push(line);
    }
    const value = clean(block.join("\n"));
    if (value) blocks.push(value);
  }
  return [...new Set(blocks)].join("\n").slice(0, PDF_SCOPE_MAX_CHARS);
}
