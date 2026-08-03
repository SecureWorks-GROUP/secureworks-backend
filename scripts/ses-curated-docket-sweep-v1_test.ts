// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bytesToBase64,
  changedDependencyPaths,
  commandOutputWithTimeout,
  CURRENT_WIKI_RENDER_ENV,
  currentWikiRendererCommand,
  parseOptions,
  parseRemoteMainRevision,
  reviewedWikiRepoPath,
} from "./ses-curated-docket-sweep-v1.ts";
import { SweepRefusal } from "./ses-curated-docket-sweep-v1-core.ts";
import { canonicalSesJson } from "../supabase/functions/ops-api/ses_docket_envelope.ts";
import { canonicalCurrentWikiReportHashPayload } from "../supabase/functions/ops-api/makesafe_report_render.ts";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function stableInputHash(job: Record<string, unknown>): Promise<string> {
  return await sha256(new TextEncoder().encode(canonicalSesJson(
    canonicalCurrentWikiReportHashPayload(job),
  )));
}

Deno.test("operator defaults to dry-run and an untracked manifest path", () => {
  const options = parseOptions([]);
  assertEquals(options.mode, "dry_run");
  assert(options.manifest.startsWith("/tmp/"));
});

Deno.test("apply is explicit and consumes a named reviewed manifest", () => {
  assertEquals(parseOptions(["--apply", "--manifest", "/tmp/reviewed.json"]), {
    mode: "apply",
    manifest: "/tmp/reviewed.json",
  });
  assertThrows(() => parseOptions(["--unknown"]), Error, "unknown option");
});

Deno.test("current wiki checkout path is explicit, absolute, and never hard-coded", () => {
  assertEquals(reviewedWikiRepoPath("/tmp/current-wiki"), "/tmp/current-wiki");
  assertThrows(() => reviewedWikiRepoPath(""), Error, "SW_WIKI_REPO");
  assertThrows(() => reviewedWikiRepoPath("relative/wiki"), Error, "absolute");
});

Deno.test("remote main parser accepts only the exact heads/main ls-remote row", () => {
  const revision = "a".repeat(40);
  assertEquals(
    parseRemoteMainRevision(
      `${"b".repeat(40)}\trefs/pull/1/head\n${revision}\trefs/heads/main\n`,
    ),
    revision,
  );
  assertThrows(() =>
    parseRemoteMainRevision(`${revision}\trefs/heads/other\n`)
  );
});

Deno.test("unrelated remote movement preserves a byte-identical renderer dependency set", () => {
  const reviewed = { renderer: "hash-a", contract: "hash-b" };
  assertEquals(changedDependencyPaths(reviewed, { ...reviewed }), []);
  assertEquals(
    changedDependencyPaths(reviewed, {
      renderer: "hash-a",
      contract: "changed",
    }),
    ["contract"],
  );
});

Deno.test("chunked base64 handles multi-MiB report bytes without call-stack spread", () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const encoded = bytesToBase64(bytes);
  assertEquals(encoded.length, Math.ceil(bytes.length / 3) * 4);
  const decoded = Uint8Array.from(
    atob(encoded),
    (value) => value.charCodeAt(0),
  );
  assertEquals(decoded[0], bytes[0]);
  assertEquals(decoded[2_000_000], bytes[2_000_000]);
  assertEquals(decoded.at(-1), bytes.at(-1));
});

Deno.test("current-wiki subprocess timeout is bounded per card", async () => {
  await assertRejects(
    () =>
      commandOutputWithTimeout(
        new Deno.Command("python3", {
          args: ["-c", "import time; time.sleep(1)"],
          stdout: "piped",
          stderr: "piped",
        }),
        20,
      ),
    SweepRefusal,
    "per-card time limit",
  );
});

Deno.test("two temp-root renders keep identical input and PDF hashes", async () => {
  assertEquals(CURRENT_WIKI_RENDER_ENV, { RL_invariant: "1" });
  const first = await Deno.makeTempDir({ prefix: "review-render-" });
  const second = await Deno.makeTempDir({ prefix: "apply-render-" });
  try {
    const renderer = `${first}/renderer.py`;
    await Deno.writeTextFile(
      renderer,
      `import argparse, hashlib, json, os\nfrom pathlib import Path\nfrom reportlab.pdfgen import canvas\nap = argparse.ArgumentParser()\nap.add_argument("job")\nap.add_argument("--out", required=True)\nargs = ap.parse_args()\nassert os.environ.get("RL_invariant") == "1"\njob = json.loads(Path(args.job).read_text())\nphoto = Path(job["photos"][0]["file"])\nphoto_bytes = photo.read_bytes()\nassert hashlib.sha256(photo_bytes).hexdigest() == job["photos"][0]["content_sha256"]\nout = Path(args.out)\nout.mkdir(parents=True, exist_ok=True)\nc = canvas.Canvas(str(out / "report.pdf"))\nc.drawString(72, 720, job["ref"] + " | " + job["photos"][0]["content_sha256"])\nc.save()\n`,
    );
    const photoBytes = new TextEncoder().encode("privacy-safe-photo-fixture");
    const contentHash = await sha256(photoBytes);
    const jobs = [first, second].map((root) => ({
      ref: "REF-001",
      photos: [{
        evidence_id: "photo-1",
        caption: "Completion evidence",
        content_sha256: contentHash,
        file: `${root}/photo-1.jpg`,
      }],
    }));
    await Promise.all(
      jobs.map((job) => Deno.writeFile(job.photos[0].file, photoBytes)),
    );
    assertEquals(
      await stableInputHash(jobs[0]),
      await stableInputHash(jobs[1]),
    );

    const pdfHashes: string[] = [];
    for (let index = 0; index < jobs.length; index++) {
      const root = index === 0 ? first : second;
      const input = `${root}/job.json`;
      const out = `${root}/out`;
      await Deno.writeTextFile(input, JSON.stringify(jobs[index]));
      const result = await currentWikiRendererCommand(renderer, input, out)
        .output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      pdfHashes.push(await sha256(await Deno.readFile(`${out}/report.pdf`)));
    }
    assertEquals(pdfHashes[0], pdfHashes[1]);

    const changed = structuredClone(jobs[1]);
    changed.photos[0].content_sha256 = "b".repeat(64);
    assertNotEquals(
      await stableInputHash(jobs[0]),
      await stableInputHash(changed),
    );
  } finally {
    await Deno.remove(first, { recursive: true });
    await Deno.remove(second, { recursive: true });
  }
});
