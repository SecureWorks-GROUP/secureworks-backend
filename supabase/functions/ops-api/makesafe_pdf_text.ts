// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  extractText as extractTextWithUnpdf,
  getDocumentProxy,
} from "npm:unpdf@1.6.2";
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
// The primary extractor is unpdf's serverless PDF.js build, pinned in deno.lock and
// supported by the Deno/Supabase runtime. It resolves generated Type0/CID fonts via
// their ToUnicode maps, which the original content-stream heuristic cannot do. The
// heuristic remains as a dependency-independent fallback for malformed legacy
// fixtures and simple PDFs. Every path is bounded and never throws.
//
// LIMITATION (documented): this reads the TEXT LAYER only. Scanned/image-only PDFs and
// PDFs whose fonts use custom CID encodings without a plain text layer yield little or
// no usable text and correctly fall through to the document-block path. Non-Flate
// stream filters (LZW, ASCII85+Flate chains, etc.) are not decoded; those streams are
// skipped, and if no stream yields text the email uses the document path.

/** Minimum extracted-text length (chars) to prefer the cheap text path over the
 * document block. Below this an email is treated as a scanned/low-text PDF. */
export const PDF_TEXT_MIN_CHARS = 200;
export const PDF_TEXT_MAX_BYTES = 5_000_000;
export const PDF_TEXT_MAX_PAGES = 25;
export const PDF_TEXT_MAX_CHARS = 40_000;

export type PdfTextMode = "text" | "none";

export interface PdfTextResult {
  /** Extracted text-layer content (empty when mode='none'). */
  text: string;
  /**
   * The recovered text-layer content REGARDLESS of the model-path quality gate.
   * `text` is emptied when `looksLikeText()` rejects the blob (so the model keeps
   * the safe document-block path); `rawText` always carries whatever was decoded so
   * a targeted deterministic parse (e.g. the MLB WO client-block reader in
   * makesafe_pdf_client_fields.ts) can still run label-anchored extraction on a blob
   * that is too noisy to hand to the model wholesale. Empty only when nothing decoded.
   */
  rawText: string;
  /** Number of usable characters in `text`. */
  charCount: number;
  /** 'text' when enough clean text was recovered to feed the model; else 'none'. */
  mode: PdfTextMode;
  /** How many content streams were successfully decoded (observability). */
  streamsDecoded: number;
  /** Extractor that produced rawText/text. */
  extractor?: "unpdf@1.6.2" | "content_stream_v1";
  /** Parsed page count when the primary PDF.js path opened the document. */
  pageCount?: number;
  /** True when readable text was capped at PDF_TEXT_MAX_CHARS. */
  truncated?: boolean;
  /** Set when extraction bailed for a non-fatal reason (observability, never thrown). */
  note?: string;
}

// ── byte helpers (structural scan runs on raw bytes, not a decoded string, so
// byte offsets into the compressed stream payload stay exact) ──
function indexOfBytes(
  hay: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
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

async function inflate(
  bytes: Uint8Array,
  format: "deflate" | "deflate-raw",
): Promise<Uint8Array | null> {
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
            case "n":
              buf += "\n";
              i += 2;
              break;
            case "r":
              buf += "\r";
              i += 2;
              break;
            case "t":
              buf += "\t";
              i += 2;
              break;
            case "b":
              buf += "\b";
              i += 2;
              break;
            case "f":
              buf += "\f";
              i += 2;
              break;
            case "(":
              buf += "(";
              i += 2;
              break;
            case ")":
              buf += ")";
              i += 2;
              break;
            case "\\":
              buf += "\\";
              i += 2;
              break;
            default: {
              // octal escape \ddd, else drop the backslash
              if (next >= "0" && next <= "7") {
                let oct = "";
                let k = i + 1;
                while (
                  k < n && oct.length < 3 && content[k] >= "0" &&
                  content[k] <= "7"
                ) {
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
  return pieces.join(" ").replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, "\n")
    .trim();
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
  if (printableRatio < 0.85 || letterRatio < 0.25) return false;

  const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) ?? [];
  const counts = new Map<string, number>();
  let dominantCount = 0;
  for (const word of words) {
    const count = (counts.get(word) ?? 0) + 1;
    counts.set(word, count);
    if (count > dominantCount) dominantCount = count;
  }

  // Some generated PDFs expose only repeated metadata/locale tokens (for example
  // "en-AU en-AU ..."). That is printable and letter-heavy, but it is not usable
  // work-order content, so force the safe document-block fallback.
  if (
    words.length >= 20 &&
    (counts.size < 8 || dominantCount / words.length >= 0.45 ||
      counts.size / words.length < 0.2)
  ) {
    return false;
  }

  return true;
}

/**
 * Extract the embedded text layer from a PDF. Deterministic, key-less, edge-safe.
 * Returns mode:'text' with the recovered content when there is enough clean text to
 * feed the classifier cheaply; otherwise mode:'none' so the caller keeps the current
 * document-block path. NEVER throws — every failure degrades to mode:'none'.
 */
async function extractPdfTextFromContentStreams(
  bytes: Uint8Array,
): Promise<PdfTextResult> {
  const empty: PdfTextResult = {
    text: "",
    rawText: "",
    charCount: 0,
    mode: "none",
    streamsDecoded: 0,
  };
  try {
    if (!bytes || bytes.length < 5) return { ...empty, note: "empty" };
    // Cheap sanity: a real PDF starts with %PDF-. If not, don't try.
    if (
      !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
        bytes[3] === 0x46)
    ) {
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
      const isImageish =
        /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(
          dict,
        );

      searchFrom = eIdx + KW_ENDSTREAM.length;
      if (isImageish) continue;
      if (dataEnd <= dataStart) continue;

      const rawSlice = bytes.subarray(dataStart, dataEnd);
      let contentBytes: Uint8Array | null = null;
      if (isFlate) {
        contentBytes = await inflate(rawSlice, "deflate");
        if (!contentBytes) {
          contentBytes = await inflate(rawSlice, "deflate-raw");
        }
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
      return {
        text: "",
        // Keep the decoded blob for label-anchored deterministic parses even though it
        // is too noisy to feed the model wholesale (invariant 2 unchanged: `text` is
        // still empty, so the model keeps the document-block path).
        rawText: text,
        charCount: text.length,
        mode: "none",
        streamsDecoded,
        note: text.length ? "low_quality_text" : "no_text_layer",
      };
    }
    return {
      text,
      rawText: text,
      charCount: text.length,
      mode: "text",
      streamsDecoded,
      extractor: "content_stream_v1",
    };
  } catch (e) {
    return { ...empty, note: `error:${(e as Error).message}`.slice(0, 120) };
  }
}

/**
 * Extract a bounded digital text layer from a PDF. PDF.js handles generated
 * builder work orders, including ToUnicode/CID fonts; the original stream reader
 * remains a fallback. Image-only, corrupt and pathological inputs return
 * mode:'none' with a fixed reason for per-source quarantine.
 */
export async function extractPdfText(
  bytes: Uint8Array,
): Promise<PdfTextResult> {
  const empty: PdfTextResult = {
    text: "",
    rawText: "",
    charCount: 0,
    mode: "none",
    streamsDecoded: 0,
  };
  if (!bytes || bytes.length < 5) return { ...empty, note: "empty" };
  if (
    !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
      bytes[3] === 0x46)
  ) {
    return { ...empty, note: "not_pdf" };
  }
  if (bytes.byteLength > PDF_TEXT_MAX_BYTES) {
    return { ...empty, note: "pdf_too_large" };
  }

  let pdf: any = null;
  try {
    // PDF.js may transfer its input buffer to a worker. Keep the caller's bytes
    // intact for attachment staging and for the fallback extractor.
    pdf = await getDocumentProxy(bytes.slice());
    const pageCount = Number(pdf?.numPages || 0);
    if (pageCount < 1) {
      return { ...empty, pageCount, note: "no_pages" };
    }
    if (pageCount > PDF_TEXT_MAX_PAGES) {
      return { ...empty, pageCount, note: "pdf_too_many_pages" };
    }
    const extracted = await extractTextWithUnpdf(pdf);
    const joined = Array.isArray(extracted.text)
      ? extracted.text.join("\n")
      : String(extracted.text || "");
    const normalized = joined.replace(/\r\n?/g, "\n").replace(
      /[ \t]+\n/g,
      "\n",
    ).replace(/\n{3,}/g, "\n\n").trim();
    const truncated = normalized.length > PDF_TEXT_MAX_CHARS;
    const text = normalized.slice(0, PDF_TEXT_MAX_CHARS);
    if (!looksLikeText(text)) {
      return {
        ...empty,
        rawText: text,
        charCount: text.length,
        extractor: "unpdf@1.6.2",
        pageCount,
        truncated,
        note: text.length ? "low_quality_text" : "no_text_layer",
      };
    }
    return {
      text,
      rawText: text,
      charCount: text.length,
      mode: "text",
      streamsDecoded: 0,
      extractor: "unpdf@1.6.2",
      pageCount,
      truncated,
    };
  } catch {
    const fallback = await extractPdfTextFromContentStreams(bytes);
    return fallback.rawText || fallback.mode === "text"
      ? { ...fallback, extractor: "content_stream_v1" }
      : { ...fallback, note: "pdf_parse_failed" };
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {
      // Destruction is best-effort; extraction output remains deterministic.
    }
  }
}
