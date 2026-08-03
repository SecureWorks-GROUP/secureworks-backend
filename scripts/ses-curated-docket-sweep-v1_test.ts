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
import {
  canonicalCurrentWikiReportHashPayload,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";

const REAL_RENDERER_DEPENDENCIES = [
  "scripts/render_makesafe_report.py",
  "scripts/photo_labeling.py",
  "scripts/report_commercial_content.py",
  "scripts/report_content_contract.py",
  "assets/secureworks-group-main-cropped.png",
] as const;
const REAL_RENDERER_SKILL_ROOT =
  "harness/ops/skills/secureworks-makesafe-reporting";

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

async function materializeRealRenderer(
  wikiRepo: string,
  root: string,
): Promise<string> {
  for (const relative of REAL_RENDERER_DEPENDENCIES) {
    const result = await new Deno.Command("git", {
      cwd: wikiRepo,
      args: [
        "show",
        `${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}:${REAL_RENDERER_SKILL_ROOT}/${relative}`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      result.success,
      `current wiki dependency unavailable: ${relative}: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
    const target = `${root}/${relative}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(target, result.stdout);
  }
  return `${root}/scripts/render_makesafe_report.py`;
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

Deno.test({
  name:
    "current pinned wiki renderer produces identical PDF bytes across temp roots",
  ignore: !Deno.env.get("SW_WIKI_REPO"),
  fn: async () => {
    assertEquals(CURRENT_WIKI_RENDER_ENV, { RL_invariant: "1" });
    const wikiRepo = reviewedWikiRepoPath(Deno.env.get("SW_WIKI_REPO"));
    const first = await Deno.makeTempDir({ prefix: "review-render-" });
    const second = await Deno.makeTempDir({ prefix: "apply-render-" });
    try {
      const roots = [first, second];
      const renderers = await Promise.all(
        roots.map((root) => materializeRealRenderer(wikiRepo, root)),
      );
      assertEquals(
        await sha256(await Deno.readFile(renderers[0])),
        MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
      );
      assertEquals(
        await Deno.readFile(renderers[0]),
        await Deno.readFile(renderers[1]),
      );
      const photoBytes = await Deno.readFile(
        `${first}/assets/secureworks-group-main-cropped.png`,
      );
      const contentHash = await sha256(photoBytes);
      const jobs = roots.map((root) => ({
        ref: "REF-001",
        address: "Example Suburb",
        contact: "Generic Site Contact",
        date: "2026-08-03",
        arrival: "09:00",
        scope: "Secure the affected opening.",
        findings: "The opening was exposed.",
        works: "The opening was secured.",
        materials_evidence: { state: "none_recorded", items: [] },
        photos: [{
          evidence_id: "photo-1",
          caption: "Completion evidence",
          content_sha256: contentHash,
          file: `${root}/assets/secureworks-group-main-cropped.png`,
        }],
        photo_evidence: {
          source_revision: "privacy-safe-fixture-v1",
          completeness_verified: true,
          source_count: 1,
          applicable_count: 1,
          selected_count: 1,
          applicable_ids: ["photo-1"],
          selected_ids: ["photo-1"],
          excluded: [],
          rejected: [],
        },
        output_name: "report.pdf",
      }));
      assertEquals(
        await stableInputHash(jobs[0]),
        await stableInputHash(jobs[1]),
      );

      const pdfBytes: Uint8Array[] = [];
      for (let index = 0; index < jobs.length; index++) {
        const input = `${roots[index]}/job.json`;
        const out = `${roots[index]}/out`;
        await Deno.writeTextFile(input, JSON.stringify(jobs[index]));
        const result = await currentWikiRendererCommand(
          renderers[index],
          input,
          out,
        ).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
        pdfBytes.push(await Deno.readFile(`${out}/report.pdf`));
      }
      assertEquals(pdfBytes[0], pdfBytes[1]);
      assertEquals(await sha256(pdfBytes[0]), await sha256(pdfBytes[1]));

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
  },
});
