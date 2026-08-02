// deno-lint-ignore-file no-import-prefix
/** Regression: building the make-safe report's renderer input must not re-encode the photo set.
 *
 * `prepare_ses_docket_revision` returned HTTP 546 WORKER_RESOURCE_LIMIT on the persist of the
 * board's heaviest cards while the identical dry run finished in seconds. The artifact-hash fix
 * that preceded this one moved the cliff but did not remove it: the remaining amplifier was
 * `physicalReportRenderJob`, which built a binary string one character at a time and then base64'd
 * it, for EVERY current-cycle photo.
 *
 * Measured end to end through `prepare_ses_docket_revision` at the real board volumes (photo
 * counts and byte totals read read-only from production storage metadata), peak RSS, max of
 * three runs:
 *
 *   | photos / bytes                    | before | after |
 *   |-----------------------------------|--------|-------|
 *   |  35 / 15.1 MB (persisted OK)      | 238 MB | 143 MB|
 *   |  50 / 20.9 MB (returned 546)      | 246 MB | 157 MB|
 *   |  51 / 33.5 MB (heaviest on board) | 431 MB | 199 MB|
 *   | 150 / 62.7 MB (3x the board)      | 367 MB | 226 MB|
 *
 * and, for the renderer-input build alone at the heaviest volume, a heap growth of 206-280 MB
 * for 33.5 MB of photos (6-8x) before, versus 0.03 MB (0.001x) after.
 *
 * jsPDF accepts a Uint8Array directly and emits a byte-identical image stream, so the fix trades
 * nothing away: every photo is still passed, still hashed, still uploaded, the report embeds the
 * same evidence, and the render hash is unmoved. The tests below pin all four of those.
 *
 * These tests fail on the old shape and pass on the direct-bytes one.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  SesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";
import { physicalReportRenderJob } from "./ses_assembler_input_adapter.ts";
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

Deno.test("renderer input allocates a bounded fraction of the photo bytes, not a multiple of them", () => {
  // heapUsed is read WITHOUT forcing a collection on purpose: the old shape's cost was mostly
  // transient cons-string garbage, and that garbage is exactly what the worker's memory limit
  // counts. Measured at this volume: 206 MB (6.1x) on the old shape, 0.03 MB (0.001x) on this one.
  const artifacts = photoArtifacts(WORST_CASE_PHOTOS, WORST_CASE_MB);
  const rawBytes = artifacts.reduce(
    (total, a) => total + a.bytes.byteLength,
    0,
  );
  const { input, snapshot } = fixtures(WORST_CASE_PHOTOS);

  const before = Deno.memoryUsage().heapUsed;
  const job = physicalReportRenderJob(snapshot, input, artifacts);
  const grew = Deno.memoryUsage().heapUsed - before;

  assertEquals(job.photos?.length, WORST_CASE_PHOTOS);
  const budget = rawBytes / 4;
  assert(
    grew < budget,
    `building the renderer input for ${WORST_CASE_PHOTOS} photos / ` +
      `${(rawBytes / 1048576).toFixed(1)} MB grew the heap by ` +
      `${(grew / 1048576).toFixed(1)} MB (${
        (grew / rawBytes).toFixed(2)
      }x the photo bytes); ` +
      `budget is ${
        (budget / 1048576).toFixed(1)
      } MB. This is the allocation that made the ` +
      `persist path return WORKER_RESOURCE_LIMIT.`,
  );
});

Deno.test("every current-cycle photo still reaches the renderer, in order, with its exact bytes", () => {
  // The budget must never have been bought by sampling, truncating or dropping evidence.
  const artifacts = photoArtifacts(WORST_CASE_PHOTOS, 1);
  const { input, snapshot } = fixtures(WORST_CASE_PHOTOS);
  const job = physicalReportRenderJob(snapshot, input, artifacts);

  assertEquals(job.photos?.length, artifacts.length);
  for (const [index, photo] of (job.photos || []).entries()) {
    const source = artifacts[index];
    assertEquals(photo.caption, `Evidence ${index + 1}`);
    assertEquals(photo.contentType, source.media_type);
    // Identity, not a copy: the renderer reads the same buffer the docket uploads and hashes.
    assert(
      photo.bytes === source.bytes,
      `photo ${index + 1} did not reach the renderer as the recovered bytes`,
    );
  }
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
  name:
    "the persist render path fits a constrained worker heap at the board's heaviest volume",
  // A subprocess with a hard old-space cap is the honest reproduction of the worker limit. The
  // repo's `test:ops-api` task does not grant --allow-run, so this case is skipped there and runs
  // under `deno test --allow-run ...` (the same condition as ses_artifact_hash_budget_test.ts).
  ignore: (await Deno.permissions.query({
    name: "run",
    command: Deno.execPath(),
  })).state !== "granted",
  fn: async () => {
    const adapter = new URL("./ses_assembler_input_adapter.ts", import.meta.url)
      .href;
    const renderer = new URL("./makesafe_report_render.ts", import.meta.url)
      .href;
    const self = new URL(import.meta.url).href;
    const script = `
      import { physicalReportRenderJob } from "${adapter}";
      import { renderMakesafeReportPdf } from "${renderer}";
      import { syntheticJpeg } from "${self}";
      const count = ${WORST_CASE_PHOTOS};
      const per = Math.floor((${WORST_CASE_MB} * 1024 * 1024) / count);
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
      const input = {
        identity: { job_number: "SWMS-000000" },
        source: {
          builder_reference: "REF-70062",
          site_address: "Address not recorded",
          instruction_text: "Fixture instruction",
        },
        cycle_facts: {
          trade_report: { checklist_json: { works_completed: "Work completed safely." } },
          photos,
        },
      };
      const snapshot = { job: { client_name: null }, assignments: [{ crew_name: "Field crew" }] };
      const job = physicalReportRenderJob(snapshot, input, artifacts);
      if (job.photos.length !== count) throw new Error("photo set was reduced");
      const rendered = await renderMakesafeReportPdf(job);
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
      `rendering ${WORST_CASE_PHOTOS} photos / ${WORST_CASE_MB} MB aborted under a ` +
        `${HEAP_CAP_MB} MB heap cap, which is the WORKER_RESOURCE_LIMIT the persist path ` +
        `returned in production:\n${stderr}`,
    );
    assert(stdout.includes("OK"), stdout + stderr);
  },
});
