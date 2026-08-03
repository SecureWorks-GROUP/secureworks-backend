// deno-lint-ignore-file no-import-prefix
/** Regression coverage for the photo contract after docket assembly moved to trusted artifacts.
 *
 * Raw trade-report evidence must remain fail-closed even when its current cycle has a large photo
 * set. The curated renderer still consumes Uint8Array images directly, preserves the established
 * render-hash normalization, and renders the contract's eight selected photos within a constrained
 * worker heap. The tests below pin those independent guarantees without implying that the docket
 * assembler may render raw checklist fields.
 */
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  SesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";
import {
  physicalReportRenderJob,
  SesAssemblerAdapterError,
} from "./ses_assembler_input_adapter.ts";
import type { SesAssemblerInputV1 } from "./ses_docket_envelope.ts";
import type { SesPhotoArtifact } from "./ses_prepare_docket_revision.ts";
import {
  makesafeReportHashInput,
  renderHash,
  renderMakesafeReportPdf,
} from "./makesafe_report_render.ts";

/** The heaviest card on the live board: 51 current-cycle photos totalling 33.5 MB. */
const WORST_CASE_PHOTOS = 51;
const WORST_CASE_MB = 33.5;
/** V8 old-space cap for the subprocess reproduction. Strings live in old space and byte buffers
 * do not, which is exactly why the old shape aborts here and the new shape fits in a heap barely
 * larger than the photo set itself. Measured: old aborts at 64 MB, passes at 80; new passes at 48. */
const HEAP_CAP_MB = 64;

/** SOI, JFIF APP0, SOF0 declaring 1600x1200, then SOS. jsPDF reads the SOF0 dimensions and
 * embeds the entropy stream verbatim (DCTDecode), so a header this small is enough for it to
 * treat the buffer as a real baseline JPEG. */
const JPEG_HEAD = [
  "ffd8", // SOI
  "ffe000104a46494600010100000100010000", // APP0 / JFIF
  "ffc0001108" + "04b0" + "0640" + "03011100021101031101", // SOF0, 1600x1200
  "ffda000c03010002110311003f00", // SOS
].join("");

/** A structurally valid baseline JPEG whose scan data is `payload` bytes of marker-free noise. */
export function syntheticJpeg(payload: number, seed = 0): Uint8Array {
  const head = Uint8Array.from(
    JPEG_HEAD.match(/../g) as string[],
    (pair) => parseInt(pair, 16),
  );
  const bytes = new Uint8Array(Math.max(head.length + 2, payload));
  bytes.set(head, 0);
  for (let index = head.length; index < bytes.length - 2; index++) {
    bytes[index] = (index * 37 + 13 + seed * 7) % 251;
  }
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function cyclePhotos(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `photo-${index + 1}`,
    path_or_key: `job_media:media-${index + 1}`,
    caption: `Evidence ${index + 1}`,
    order: index + 1,
  }));
}

function photoArtifacts(count: number, totalMb: number): SesPhotoArtifact[] {
  const per = Math.floor((totalMb * 1024 * 1024) / count);
  return cyclePhotos(count).map((photo, index) => ({
    photo_id: photo.id,
    source_pointer: photo.path_or_key,
    file_name: `${String(index + 1).padStart(3, "0")}.jpg`,
    media_type: "image/jpeg" as const,
    bytes: syntheticJpeg(per, index + 1),
  }));
}

/** Only the fields `physicalReportRenderJob` reads. No client-identifying values. */
function fixtures(count: number) {
  const photos = cyclePhotos(count);
  const input = {
    identity: { job_number: "SWMS-000000" },
    source: {
      builder_reference: "REF-70062",
      site_address: "Address not recorded",
      instruction_text: "Fixture instruction",
    },
    cycle_facts: {
      trade_report: {
        checklist_json: {
          works_completed: "Work completed safely.",
          attendance_date: "2026-07-27",
          arrival_time: "08:30",
        },
      },
      photos,
    },
  } as unknown as SesAssemblerInputV1;
  const snapshot = {
    job: { client_name: null },
    assignments: [{ crew_name: "Field crew" }],
  } as unknown as SesAssemblerLiveSnapshot;
  return { input, snapshot };
}

Deno.test("the raw trade-report adapter stays fail-closed even when photo bytes are present", () => {
  const artifacts = photoArtifacts(WORST_CASE_PHOTOS, WORST_CASE_MB);
  const { input, snapshot } = fixtures(WORST_CASE_PHOTOS);
  assertThrows(
    () => physicalReportRenderJob(snapshot, input, artifacts),
    SesAssemblerAdapterError,
    "Raw trade-report fields are immutable evidence",
  );
});

Deno.test("the render hash is unmoved by which input form the caller supplies", async () => {
  // `bytes` and `bytesBase64` of the same content must produce the same digest, so this change
  // cannot silently re-version every rendered report.
  const bytes = syntheticJpeg(9_001, 3);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const bytesBase64 = btoa(binary);

  const base = { ref: "REF-70062", address: "Address not recorded" };
  assertEquals(
    makesafeReportHashInput({
      ...base,
      photos: [{ bytes, contentType: "image/jpeg" }],
    }),
    makesafeReportHashInput({
      ...base,
      photos: [{ bytesBase64, contentType: "image/jpeg" }],
    }),
  );
  assertEquals(
    await renderHash({
      ...base,
      photos: [{ bytes, contentType: "image/jpeg" }],
    }),
    await renderHash({
      ...base,
      photos: [{ bytesBase64, contentType: "image/jpeg" }],
    }),
  );
  // A different photo LENGTH must still move the digest.
  assert(
    await renderHash({
      ...base,
      photos: [{ bytes, contentType: "image/jpeg" }],
    }) !==
      await renderHash({
        ...base,
        photos: [{
          bytes: syntheticJpeg(12_001, 3),
          contentType: "image/jpeg",
        }],
      }),
  );
});

Deno.test("the rendered report embeds an identical image stream from either input form", async () => {
  const photos = [syntheticJpeg(24_001, 1), syntheticJpeg(31_001, 2)];
  const base64 = photos.map((bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const job = {
    ref: "REF-70062",
    address: "Address not recorded",
    scope: "Fixture instruction",
    findings: "Fixture finding",
    works: "Work completed safely.",
    materials: "Star pickets x 20.",
  };
  const fromBytes = await renderMakesafeReportPdf({
    ...job,
    photos: photos.map((bytes) => ({ bytes, contentType: "image/jpeg" })),
  });
  const fromBase64 = await renderMakesafeReportPdf({
    ...job,
    photos: base64.map((bytesBase64) => ({
      bytesBase64,
      contentType: "image/jpeg",
    })),
  });

  assertEquals(fromBytes.bytes.byteLength, fromBase64.bytes.byteLength);
  // jsPDF stamps a non-deterministic /ID on every document, so normalise only that.
  const normalise = (pdf: Uint8Array) =>
    new TextDecoder("latin1").decode(pdf).replace(
      /\/ID \[ <[0-9A-F]+> <[0-9A-F]+> \]/,
      "/ID [ <ID> <ID> ]",
    );
  assertEquals(normalise(fromBytes.bytes), normalise(fromBase64.bytes));
});

Deno.test({
  name: "the eight-photo curated render fits a constrained worker heap",
  // A subprocess with a hard old-space cap is the honest reproduction of the worker limit. The
  // repo's `test:ops-api` task does not grant --allow-run, so this case is skipped there and runs
  // under `deno test --allow-run ...` (the same condition as ses_artifact_hash_budget_test.ts).
  ignore: (await Deno.permissions.query({
    name: "run",
    command: Deno.execPath(),
  })).state !== "granted",
  fn: async () => {
    const renderer = new URL("./makesafe_report_render.ts", import.meta.url)
      .href;
    const self = new URL(import.meta.url).href;
    const script = `
      import { renderMakesafeReportPdf } from "${renderer}";
      import { syntheticJpeg } from "${self}";
      const count = 8;
      const per = Math.floor((8 * 1024 * 1024) / count);
      const photos = Array.from({ length: count }, (_u, i) => ({
        id: "photo-" + (i + 1),
        path_or_key: "job_media:media-" + (i + 1),
        caption: "Evidence " + (i + 1),
        order: i + 1,
      }));
      const artifacts = photos.map((photo, i) => ({
        photo_id: photo.id,
        source_pointer: photo.path_or_key,
        file_name: String(i + 1).padStart(3, "0") + ".jpg",
        media_type: "image/jpeg",
        bytes: syntheticJpeg(per, i + 1),
      }));
      const rendered = await renderMakesafeReportPdf({
        ref: "REF-70062",
        address: "Address not recorded",
        crew: "1 trade",
        scope: "Fixture instruction",
        findings: "Fixture finding",
        works: "Work completed safely.",
        materials: "Star pickets x 20.",
        photos: artifacts.map((artifact, index) => ({
          bytes: artifact.bytes,
          contentType: artifact.media_type,
          caption: photos[index].caption,
        })),
      });
      if (!rendered.bytes.byteLength) throw new Error("empty report");
      console.log("OK");
    `;
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-net",
        "--allow-env",
        `--v8-flags=--max-old-space-size=${HEAP_CAP_MB}`,
        "-",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const output = await child.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(
      output.success,
      `rendering eight curated photos aborted under a ` +
        `${HEAP_CAP_MB} MB heap cap:\n${stderr}`,
    );
    assert(stdout.includes("OK"), stdout + stderr);
  },
});
