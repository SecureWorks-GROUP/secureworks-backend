// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bytesToBase64,
  changedDependencyPaths,
  commandOutputWithTimeout,
  parseOptions,
  parseRemoteMainRevision,
  reviewedWikiRepoPath,
} from "./ses-curated-docket-sweep-v1.ts";
import { SweepRefusal } from "./ses-curated-docket-sweep-v1-core.ts";

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
