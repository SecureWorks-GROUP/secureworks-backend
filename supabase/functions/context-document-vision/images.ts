// The pictures the vision reader sends (gap plan B-5b). Pure byte work, no
// model, no network, never throws.
//
// A photo is sent as it is stored, when its format is one the model takes
// (JPEG, PNG, GIF, WebP). A scanned PDF is sent as the JPEG page images it
// already holds: a scanner writes each page as one DCTDecode image, and those
// bytes are a JPEG file as they stand, so nothing is decoded or re-encoded
// (the AGENTS.md memory rule: never turn bytes into strings to move them). A
// scan whose pages are stored another way (CCITT fax, JBIG2, Flate pixels) is
// not supported and is counted, so the desk can see whether that bucket is
// worth a rasteriser.

export type ImageFormat = "jpeg" | "png" | "gif" | "webp";

export interface Picture {
  media_type: `image/${ImageFormat}`;
  bytes: Uint8Array;
}

/** What a stored image file is, by its first bytes. */
export function sniffImage(bytes: Uint8Array): ImageFormat | string {
  const b = bytes;
  if (b.length < 12) return "too_short";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "gif";
  }
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12).toLowerCase();
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
    if (brand === "avif" || brand === "avis") return "avif";
    return "iso_media";
  }
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)
  ) return "tiff";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return "pdf";
  }
  return "unknown";
}

export const SENDABLE: readonly string[] = ["jpeg", "png", "gif", "webp"];

export interface PdfPictures {
  /** The JPEG page images, in file order, at most maxImages. */
  pictures: Picture[];
  /** Page-sized JPEG images found (before the maxImages cut). */
  jpegFound: number;
  /** Page-sized images stored another way (fax, JBIG2, raw pixels). */
  otherFound: number;
}

const KW_STREAM = new TextEncoder().encode("stream");
const KW_ENDSTREAM = new TextEncoder().encode("endstream");
const KW_OBJ = new TextEncoder().encode("obj");
/** How far back from a stream keyword its dictionary may start. */
const DICT_WINDOW = 4096;

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOf(
  hay: Uint8Array,
  needle: Uint8Array,
  before: number,
  floor: number,
): number {
  outer: for (let i = before - needle.length; i >= floor; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return s;
}

function intValue(dict: string, key: string): number | null {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`));
  return m ? Number(m[1]) : null;
}

/**
 * The JPEG page images inside a PDF. Images whose shorter side is under
 * minSide (logos, icons, signatures stamped on a page) are left out, and so
 * are masks. Bounded: it walks the file once and copies only the images it
 * keeps.
 */
export function pdfJpegPictures(
  pdf: Uint8Array,
  opts: { maxImages: number; minSide: number; maxImageBytes: number },
): PdfPictures {
  const out: PdfPictures = { pictures: [], jpegFound: 0, otherFound: 0 };
  let at = 0;
  for (;;) {
    const s = indexOf(pdf, KW_STREAM, at);
    if (s < 0) break;
    at = s + KW_STREAM.length;
    // "endstream" contains "stream": skip it.
    if (s >= 3 && pdf[s - 1] === 0x64 && pdf[s - 2] === 0x6e) continue;
    const objAt = lastIndexOf(pdf, KW_OBJ, s, Math.max(0, s - DICT_WINDOW));
    if (objAt < 0) continue;
    const dict = latin1(pdf.subarray(objAt + KW_OBJ.length, s));
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    if (/\/ImageMask\s+true\b/.test(dict)) continue;
    const width = intValue(dict, "Width") ?? 0;
    const height = intValue(dict, "Height") ?? 0;
    if (Math.min(width, height) < opts.minSide) continue;
    const filter = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/)?.[1] ??
      "";
    const filters = filter.match(/\/[A-Za-z0-9]+/g) ?? [];
    if (filters.length !== 1 || filters[0] !== "/DCTDecode") {
      out.otherFound++;
      continue;
    }
    out.jpegFound++;
    if (out.pictures.length >= opts.maxImages) continue;
    // Data starts after the keyword and one end of line (CRLF or LF).
    let start = s + KW_STREAM.length;
    if (pdf[start] === 0x0d && pdf[start + 1] === 0x0a) start += 2;
    else if (pdf[start] === 0x0a || pdf[start] === 0x0d) start += 1;
    let end = -1;
    const length = intValue(dict, "Length");
    if (length !== null && start + length <= pdf.length) {
      const after = indexOf(pdf, KW_ENDSTREAM, start + length);
      if (after >= 0 && after - (start + length) <= 2) end = start + length;
    }
    if (end < 0) {
      const e = indexOf(pdf, KW_ENDSTREAM, start);
      if (e < 0) continue;
      end = e;
      while (end > start && (pdf[end - 1] === 0x0a || pdf[end - 1] === 0x0d)) {
        end--;
      }
    }
    if (end - start > opts.maxImageBytes) continue;
    const bytes = pdf.slice(start, end);
    if (sniffImage(bytes) !== "jpeg") continue;
    out.pictures.push({ media_type: "image/jpeg", bytes });
    at = end;
  }
  return out;
}

/** Base64 in chunks: never one character per byte through a string. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  // A multiple of 3 so every chunk but the last encodes without padding.
  const step = 3 * 8192;
  for (let i = 0; i < bytes.length; i += step) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return out;
}
