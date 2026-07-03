// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — LOCAL PDF TEXT-LAYER EXTRACTION (cost hardening, M1.5)
// Mission: makesafe/intake-cost-hardening (Auto-Intake v2 Wave 1 M1.5)
// ════════════════════════════════════════════════════════════
//
// The biggest cost lever in intake: a work-order PDF fed to the classifier as a
// `document` block is re-encoded and OCR-processed per page (image tokens dominate,
// ~80% of the per-email spend). For a TEXT-LAYER PDF (a generated builder WO, not a
// scan) the same information is already sitting in the PDF's content streams as plain
// text — extracting it locally and sending it as a cheap `text` block costs a fraction
// of the tokens with no loss of the fields we extract.
//
// DENO-COMPATIBILITY, BY DESIGN. This extractor uses ONLY Web APIs present in the
// Deno / Supabase edge runtime — `DecompressionStream`, `TextDecoder`, `Uint8Array`.
// No npm/esm dependency (unpdf / pdf.js are heavy and fragile under edge cold-start),
// so it can never break the edge boot or fail key-less. The failure mode is always
// safe: if a stream can't be inflated (unsupported filter, runtime without
// DecompressionStream) or the extracted text looks like garbage, we return mode:'none'
// and the caller falls back to the current `document`-block path — invariant 2 (the
// same fields keep flowing) is preserved regardless.
//
// LIMITATION (documented): this reads the TEXT LAYER only. Scanned/image-only PDFs and
// PDFs whose fonts use custom CID encodings without a plain text layer yield little or
// no usable text and correctly fall through to the document-block path. Non-Flate
// stream filters (LZW, ASCII85+Flate chains, etc.) are not decoded; those streams are
// skipped, and if no stream yields text the email uses the document path.

/** Minimum extracted-text length (chars) to prefer the cheap text path over the
 * document block. Below this an email is treated as a scanned/low-text PDF. */
export const PDF_TEXT_MIN_CHARS = 200;

export type PdfTextMode = "text" | "none";

export interface PdfTextResult {
  /** Extracted text-layer content (empty when mode='none'). */
  text: string;
  /** Number of usable characters in `text`. */
  charCount: number;
  /** 'text' when enough clean text was recovered to feed the model; else 'none'. */
  mode: PdfTextMode;
  /** How many content streams were successfully decoded (observability). */
  streamsDecoded: number;
  /** Set when extraction bailed for a non-fatal reason (observability, never thrown). */
  note?: string;
}

// ── byte helpers (structural scan runs on raw bytes, not a decoded string, so
// byte offsets into the compressed stream payload stay exact) ──
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const last = hay.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const ENC = (s: string) => new TextEncoder().encode(s);
const KW_STREAM = ENC("stream");
const KW_ENDSTREAM = ENC("endstream");

// latin1 decoder: every byte → exactly one code point, so it's safe for scanning
// ASCII operators inside an (already inflated) content stream without corrupting
// offsets. Falls back to a manual map if the label is somehow unavailable.
function latin1(bytes: Uint8Array): string {
  try {
    return new TextDecoder("latin1").decode(bytes);
  } catch (_) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

async function inflate(bytes: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array | null> {
  try {
    const DS: any = (globalThis as any).DecompressionStream;
    if (typeof DS !== "function") return null;
    const stream = new DS(format);
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const out: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    // Bound the work so a pathological stream can't run away.
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        out.push(value);
        total += value.length;
        if (total > 8_000_000) break; // 8MB inflated cap
      }
    }
    let len = 0;
    for (const c of out) len += c.length;
    const merged = new Uint8Array(len);
    let off = 0;
    for (const c of out) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  } catch (_) {
    return null;
  }
}

/** Pull visible text out of one decoded PDF content stream. Collects the string
 * operands of the text-showing operators (Tj / TJ / ' / ") — parenthesised literals
 * (with PDF escape handling) and the string parts of TJ arrays. Heuristic, but for a
 * generated text-layer WO this recovers the client name / address / ref / scope. */
function textFromContentStream(content: string): string {
  const pieces: string[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "(") {
      // literal string — walk to the matching ) honouring \-escapes and nesting.
      let depth = 1;
      i++;
      let buf = "";
      while (i < n && depth > 0) {
        const c = content[i];
        if (c === "\\") {
          const next = content[i + 1];
          switch (next) {
            case "n": buf += "\n"; i += 2; break;
            case "r": buf += "\r"; i += 2; break;
            case "t": buf += "\t"; i += 2; break;
            case "b": buf += "\b"; i += 2; break;
            case "f": buf += "\f"; i += 2; break;
            case "(": buf += "("; i += 2; break;
            case ")": buf += ")"; i += 2; break;
            case "\\": buf += "\\"; i += 2; break;
            default: {
              // octal escape \ddd, else drop the backslash
              if (next >= "0" && next <= "7") {
                let oct = "";
                let k = i + 1;
                while (k < n && oct.length < 3 && content[k] >= "0" && content[k] <= "7") {
                  oct += content[k];
                  k++;
                }
                buf += String.fromCharCode(parseInt(oct, 8) & 0xff);
                i = k;
              } else {
                i += 1; // line-continuation or unknown escape: skip the backslash
              }
              break;
            }
          }
        } else if (c === "(") {
          depth++;
          buf += c;
          i++;
        } else if (c === ")") {
          depth--;
          if (depth > 0) buf += c;
          i++;
        } else {
          buf += c;
          i++;
        }
      }
      if (buf) pieces.push(buf);
    } else {
      i++;
    }
  }
  // Join with spaces; collapse runs of whitespace so the threshold reflects real text.
  return pieces.join(" ").replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** True when the recovered text is plausibly real language, not mojibake from a
 * font we couldn't decode. Guards invariant 2: a garbage >200-char blob must NOT be
 * sent to the model in place of the document block. */
export function looksLikeText(text: string): boolean {
  if (text.length < PDF_TEXT_MIN_CHARS) return false;
  let printable = 0;
  let letters = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
  }
  const printableRatio = printable / text.length;
  const letterRatio = letters / text.length;
  // Real WO text is overwhelmingly printable ASCII with a healthy share of letters.
  return printableRatio >= 0.85 && letterRatio >= 0.25;
}

/**
 * Extract the embedded text layer from a PDF. Deterministic, key-less, edge-safe.
 * Returns mode:'text' with the recovered content when there is enough clean text to
 * feed the classifier cheaply; otherwise mode:'none' so the caller keeps the current
 * document-block path. NEVER throws — every failure degrades to mode:'none'.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  const empty: PdfTextResult = { text: "", charCount: 0, mode: "none", streamsDecoded: 0 };
  try {
    if (!bytes || bytes.length < 5) return { ...empty, note: "empty" };
    // Cheap sanity: a real PDF starts with %PDF-. If not, don't try.
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      return { ...empty, note: "not_pdf" };
    }

    const parts: string[] = [];
    let streamsDecoded = 0;
    let searchFrom = 0;
    let guard = 0;
    while (guard++ < 5000) {
      const sIdx = indexOfBytes(bytes, KW_STREAM, searchFrom);
      if (sIdx < 0) break;
      // Ensure this is the `stream` keyword, not part of `endstream`.
      const prevByte = sIdx > 0 ? bytes[sIdx - 1] : 0x20;
      if (prevByte === 0x64 /* 'd' from endstream */) {
        searchFrom = sIdx + KW_STREAM.length;
        continue;
      }
      const eIdx = indexOfBytes(bytes, KW_ENDSTREAM, sIdx + KW_STREAM.length);
      if (eIdx < 0) break;

      // Stream data begins after the EOL that follows the `stream` keyword.
      let dataStart = sIdx + KW_STREAM.length;
      if (bytes[dataStart] === 0x0d) dataStart++; // CR
      if (bytes[dataStart] === 0x0a) dataStart++; // LF
      let dataEnd = eIdx;
      // endstream is often preceded by an EOL that isn't part of the data.
      if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0a) dataEnd--;
      if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0d) dataEnd--;

      // Look at the ~300 bytes of dict before the stream for the filter.
      const dictStart = Math.max(0, sIdx - 300);
      const dict = latin1(bytes.subarray(dictStart, sIdx));
      const isFlate = /\/(FlateDecode|Fl)\b/.test(dict);
      // Skip streams that clearly aren't page content we can read.
      const isImageish = /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict);

      searchFrom = eIdx + KW_ENDSTREAM.length;
      if (isImageish) continue;
      if (dataEnd <= dataStart) continue;

      const rawSlice = bytes.subarray(dataStart, dataEnd);
      let contentBytes: Uint8Array | null = null;
      if (isFlate) {
        contentBytes = await inflate(rawSlice, "deflate");
        if (!contentBytes) contentBytes = await inflate(rawSlice, "deflate-raw");
        if (!contentBytes) continue; // couldn't inflate — skip, stay safe
      } else if (!/\/Filter\b/.test(dict)) {
        // No filter → the stream is stored as-is; usable directly.
        contentBytes = rawSlice;
      } else {
        continue; // some other filter (LZW / ASCII85 chains) — not decoded
      }

      const content = latin1(contentBytes);
      // Only bother if it smells like a content stream (has text operators).
      if (!/\bTj\b|\bTJ\b|\bBT\b/.test(content)) continue;
      const piece = textFromContentStream(content);
      if (piece) {
        parts.push(piece);
        streamsDecoded++;
      }
      if (parts.join("\n").length > 40000) break; // enough; cap the work
    }

    const text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!looksLikeText(text)) {
      return { text: "", charCount: text.length, mode: "none", streamsDecoded, note: text.length ? "low_quality_text" : "no_text_layer" };
    }
    return { text, charCount: text.length, mode: "text", streamsDecoded };
  } catch (e) {
    return { ...empty, note: `error:${(e as Error).message}`.slice(0, 120) };
  }
}
