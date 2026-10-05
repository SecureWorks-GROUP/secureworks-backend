// The pictures the vision reader sends (gap plan B-5b): format sniffing, the
// JPEG page images inside a scanned PDF, and chunked base64. No network.

// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pdfJpegPictures, sniffImage, toBase64 } from "./images.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function concat(...parts: (Uint8Array | string)[]): Uint8Array {
  const bytes = parts.map((p) => typeof p === "string" ? enc(p) : p);
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** A fake JPEG: SOI, an APP0 marker, some body bytes, EOI. */
function jpeg(fill: number, size = 64): Uint8Array {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], size - 2);
  return b;
}

function imageObj(
  n: number,
  dict: string,
  data: Uint8Array,
  lengthRef = false,
): Uint8Array {
  const length = lengthRef ? `${n + 100} 0 R` : String(data.length);
  return concat(
    `${n} 0 obj\n<< /Type /XObject /Subtype /Image ${dict} /Length ${length} >>\nstream\r\n`,
    data,
    "\r\nendstream\nendobj\n",
  );
}

Deno.test("sniffImage tells the sendable formats from the rest", () => {
  assertEquals(sniffImage(jpeg(1)), "jpeg");
  assertEquals(
    sniffImage(
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        0,
      ]),
    ),
    "png",
  );
  assertEquals(sniffImage(enc("GIF89a------")), "gif");
  assertEquals(sniffImage(enc("RIFF....WEBPVP8 ")), "webp");
  assertEquals(sniffImage(enc("\0\0\0\x18ftypheic....")), "heic");
  assertEquals(sniffImage(enc("II*\0........")), "tiff");
  assertEquals(sniffImage(enc("%PDF-1.7\n....")), "pdf");
  assertEquals(sniffImage(enc("hello world!")), "unknown");
  assertEquals(sniffImage(enc("tiny")), "too_short");
});

Deno.test("pdfJpegPictures takes page-sized JPEGs in file order and skips the rest", () => {
  const page1 = jpeg(0x11, 80);
  const page2 = jpeg(0x22, 90);
  const pdf = concat(
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog >>\nendobj\n",
    // A logo: too small.
    imageObj(
      2,
      "/Width 120 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      jpeg(0x33),
    ),
    imageObj(
      3,
      "/Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      page1,
    ),
    // A mask: never sent.
    imageObj(
      4,
      "/Width 2480 /Height 3508 /ImageMask true /Filter /DCTDecode",
      jpeg(0x44),
    ),
    // Length given by reference: the end is found at endstream.
    imageObj(
      5,
      "/Width 2480 /Height 3508 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/DCTDecode]",
      page2,
      true,
    ),
    // A fax-encoded page: counted, not sent.
    imageObj(
      6,
      "/Width 2480 /Height 3508 /BitsPerComponent 1 /Filter /CCITTFaxDecode",
      new Uint8Array(32).fill(7),
    ),
    "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
  const found = pdfJpegPictures(pdf, {
    maxImages: 5,
    minSide: 300,
    maxImageBytes: 5_000_000,
  });
  assertEquals(found.jpegFound, 2);
  assertEquals(found.otherFound, 1);
  assertEquals(found.pictures.map((p) => p.media_type), [
    "image/jpeg",
    "image/jpeg",
  ]);
  assertEquals(found.pictures[0].bytes, page1);
  assertEquals(found.pictures[1].bytes, page2);

  const cut = pdfJpegPictures(pdf, {
    maxImages: 1,
    minSide: 300,
    maxImageBytes: 5_000_000,
  });
  assertEquals(cut.pictures.length, 1);
  assertEquals(cut.jpegFound, 2);

  const tooBig = pdfJpegPictures(pdf, {
    maxImages: 5,
    minSide: 300,
    maxImageBytes: 70,
  });
  assertEquals(tooBig.pictures.map((p) => p.bytes.length), []);
});

Deno.test("pdfJpegPictures finds nothing in a PDF of text or flate pixels", () => {
  const pdf = concat(
    "%PDF-1.4\n",
    "4 0 obj\n<< /Length 20 /Filter /FlateDecode >>\nstream\n",
    new Uint8Array(20).fill(9),
    "\nendstream\nendobj\n",
    imageObj(
      5,
      "/Width 1000 /Height 1400 /Filter /FlateDecode",
      new Uint8Array(40).fill(3),
    ),
  );
  const found = pdfJpegPictures(pdf, {
    maxImages: 5,
    minSide: 300,
    maxImageBytes: 5_000_000,
  });
  assertEquals(found, { pictures: [], jpegFound: 0, otherFound: 1 });
});

Deno.test("toBase64 matches btoa across chunk boundaries", () => {
  for (const size of [0, 1, 2, 3, 24_575, 24_576, 24_577, 100_000]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const b64 = toBase64(bytes);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    assertEquals(back, bytes);
  }
});
