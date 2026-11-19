type ExternalSite = { file: string; line: number[]; function: string[] };
type EntryBase = {
  id: number;
  file: string;
  function: string[];
  provider: string;
  model: string;
  what: string;
  runs: string;
  fate: string;
  safe_without_key: string;
  other_repository_sites: ExternalSite[];
};
type BackendEntry = EntryBase & {
  repo: "B";
  anchor: string[];
};
type ExternalEntry = EntryBase & {
  repo: "J";
  line: number[];
};
type Entry = BackendEntry | ExternalEntry;

type ScannedSite = {
  line: number;
  owner: string;
  anchor: string | null;
  duplicateOnLine: boolean;
};

type OrphanAnchor = {
  line: number;
  owner: string;
  anchor: string | null;
};

const root = new URL("../../../", import.meta.url);
const entries: Entry[] = JSON.parse(
  await Deno.readTextFile(new URL("paid_ai_register.json", import.meta.url)),
);
const marker =
  /api\.anthropic\.com|api\.openai\.com|new Anthropic\(|new OpenAI\(/;
const anchorTag = /\/\/\s*paid-ai-register:/;
const standaloneAnchor =
  /^\s*\/\/\s*paid-ai-register:\s*([a-z0-9][a-z0-9-]*)\s*$/;
const inlineAnchor = /\/\/\s*paid-ai-register:\s*([a-z0-9][a-z0-9-]*)\s*$/;

function scanSource(source: string): {
  sites: ScannedSite[];
  orphans: OrphanAnchor[];
} {
  const lines = source.split("\n");
  const sites: ScannedSite[] = [];
  const orphans: OrphanAnchor[] = [];
  let owner = "<module>";

  lines.forEach((line, index) => {
    const declaration = line.match(
      /^(?:export )?(?:async )?function\s+(\w+)\s*\(/,
    );
    if (declaration) owner = declaration[1];
    if (/^serve\(async\s*\(/.test(line)) owner = "<request handler>";

    const standalone = line.match(standaloneAnchor);
    if (anchorTag.test(line)) {
      if (standalone) {
        if (!marker.test(lines[index + 1] ?? "")) {
          orphans.push({ line: index + 1, owner, anchor: standalone[1] });
        }
      } else {
        const inline = line.match(inlineAnchor);
        if (!inline || !marker.test(line)) {
          orphans.push({
            line: index + 1,
            owner,
            anchor: inline?.[1] ?? null,
          });
        }
      }
    }

    if (!marker.test(line)) return;

    const inline = standalone ? null : line.match(inlineAnchor);
    const prev = index > 0 ? lines[index - 1].match(standaloneAnchor) : null;
    sites.push({
      line: index + 1,
      owner,
      anchor: inline?.[1] ?? prev?.[1] ?? null,
      duplicateOnLine: Boolean(inline && prev),
    });
  });

  return { sites, orphans };
}

// Anchors are stable one-line `// paid-ai-register: <anchor>` comments placed
// beside each paid AI call, paired with the enclosing function name. Edits
// elsewhere in the file cannot shift them, while every paid call must carry a
// unique registered anchor inside its listed function.
export function inspect(
  file: string,
  source: string,
  register: Entry[] = entries,
): string[] {
  const failures: string[] = [];
  const registered = new Map<string, string>();
  for (const entry of register) {
    if (entry.repo !== "B" || entry.file !== file) continue;
    entry.anchor.forEach((anchor, i) => {
      registered.set(anchor, entry.function[i]);
    });
  }

  const { sites, orphans } = scanSource(source);
  for (const orphan of orphans) {
    failures.push(
      `${file}:${orphan.line} (${orphan.owner}): orphaned paid-ai-register marker${
        orphan.anchor ? ` (${orphan.anchor})` : ""
      }`,
    );
  }

  const seenAnchors = new Set<string>();
  for (const site of sites) {
    if (site.duplicateOnLine) {
      failures.push(
        `${file}:${site.line} (${site.owner}): multiple paid-ai-register markers on one call`,
      );
      continue;
    }
    if (!site.anchor) {
      failures.push(
        `${file}:${site.line} (${site.owner}): unregistered paid AI marker`,
      );
      continue;
    }
    const expectedOwner = registered.get(site.anchor);
    if (!expectedOwner) {
      failures.push(
        `${file}:${site.line} (${site.owner}): unregistered paid AI marker (${site.anchor})`,
      );
      continue;
    }
    if (expectedOwner !== site.owner) {
      failures.push(
        `${file}:${site.line} (${site.owner}): anchor "${site.anchor}" expected in ${expectedOwner}`,
      );
      continue;
    }
    if (seenAnchors.has(site.anchor)) {
      failures.push(
        `${file}:${site.line} (${site.owner}): duplicate paid-ai-register marker (${site.anchor})`,
      );
      continue;
    }
    seenAnchors.add(site.anchor);
  }

  return failures;
}

async function* sources(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* sources(url);
    else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !/(?:[._-](?:test|spec)\.ts$|^test[._-])/.test(entry.name)
    ) yield url;
  }
}

Deno.test("paid AI inventory covers the tree and refuses unlisted calls or stale anchors", async () => {
  const failures: string[] = [];
  const scannedByFile = new Map<string, ScannedSite[]>();
  for await (const url of sources(new URL("supabase/functions/", root))) {
    const file = decodeURIComponent(url.pathname.slice(root.pathname.length));
    const source = await Deno.readTextFile(url);
    failures.push(...inspect(file, source, entries));
    scannedByFile.set(file, scanSource(source).sites);
  }

  const doc = await Deno.readTextFile(new URL("docs/paid-ai-callers.md", root));
  const globalAnchors = new Set<string>();
  for (const entry of entries) {
    const location = entry.repo === "B"
      ? `${entry.file}#${entry.anchor.join(",")}`
      : `${entry.file}:${entry.line.join(",")}`;
    console.log(
      `${entry.id}. ${location}${
        entry.repo === "J" ? " (other repository)" : ""
      }`,
    );
    if (entry.other_repository_sites.length) {
      console.log(
        "   other repository: " +
          entry.other_repository_sites.map((s) => `${s.file}:${s.line}`).join(
            "; ",
          ),
      );
    }
    if (entry.repo === "B") {
      if ("line" in entry) {
        failures.push(
          `row ${entry.id}: backend entry must use stable anchors, not line numbers`,
        );
      }
      if (
        !Array.isArray(entry.anchor) || entry.anchor.length === 0 ||
        entry.anchor.length !== entry.function.length
      ) {
        failures.push(
          `row ${entry.id}: anchor and function arrays must be non-empty and aligned`,
        );
      } else {
        const sites = scannedByFile.get(entry.file) ?? [];
        entry.anchor.forEach((anchor, i) => {
          if (globalAnchors.has(anchor)) {
            failures.push(`row ${entry.id}: duplicate anchor "${anchor}"`);
          }
          globalAnchors.add(anchor);
          const matches = sites.filter((site) => site.anchor === anchor);
          if (matches.length === 0) {
            failures.push(`${entry.file}#${anchor}: stale anchor`);
          } else if (matches.length > 1) {
            failures.push(`${entry.file}#${anchor}: duplicate anchor`);
          } else if (matches[0].owner !== entry.function[i]) {
            failures.push(
              `${entry.file}#${anchor}: owner mismatch (expected ${
                entry.function[i]
              }, got ${matches[0].owner})`,
            );
          }
        });
      }
    }
    // Check the table against the machine list without another maintained list.
    const tableRow = doc.split("\n").find((line) =>
      line.startsWith(`| ${entry.id} | `)
    ) || "";
    for (
      const value of [
        location,
        entry.what,
        entry.runs,
        entry.fate,
        entry.safe_without_key,
      ]
    ) {
      if (!tableRow.includes(value)) {
        failures.push(
          `row ${entry.id}: documentation drift`,
        );
      }
    }
  }

  // Virtual sources keep the proof runnable with --allow-read only.
  const path = "supabase/functions/unlisted-paid-caller/index.ts";
  const probe =
    "async function unlistedCaller() {\n  fetch('https://api.anthropic.com/v1/messages');\n}\n";
  const rejected = inspect(path, probe, entries);
  if (
    rejected.length !== 1 || !rejected[0].includes(`${path}:2 (unlistedCaller)`)
  ) {
    failures.push("unlisted function was not refused with its path and line");
  }
  const existingFileProbe = inspect(entries[0].file, probe, entries);
  if (existingFileProbe.length !== 1) {
    failures.push("unlisted function in a listed file was accepted");
  }
  const extraCallInListedFn =
    "async function submitExpense() {\n  // paid-ai-register: ops-api-expense-receipt\n  fetch('https://api.anthropic.com/v1/messages');\n  fetch('https://api.anthropic.com/v1/messages');\n}\n";
  if (
    inspect("supabase/functions/ops-api/index.ts", extraCallInListedFn, entries)
      .length !== 1
  ) {
    failures.push("extra unmarked call inside a listed function was accepted");
  }
  const duplicateMarkerProbe =
    "async function submitExpense() {\n  // paid-ai-register: ops-api-expense-receipt\n  fetch('https://api.anthropic.com/v1/messages');\n  // paid-ai-register: ops-api-expense-receipt\n  fetch('https://api.anthropic.com/v1/messages');\n}\n";
  if (
    inspect(
      "supabase/functions/ops-api/index.ts",
      duplicateMarkerProbe,
      entries,
    ).length !== 1
  ) {
    failures.push("duplicate marker anchor in a listed file was accepted");
  }
  const wrongOwnerProbe =
    "async function otherFunction() {\n  // paid-ai-register: ops-api-expense-receipt\n  fetch('https://api.anthropic.com/v1/messages');\n}\n";
  if (
    inspect("supabase/functions/ops-api/index.ts", wrongOwnerProbe, entries)
      .length !== 1
  ) {
    failures.push("anchor moved to a different function was accepted");
  }
  const orphanMarkerProbe =
    "async function submitExpense() {\n  // paid-ai-register: ops-api-expense-receipt\n  return null;\n}\n";
  if (
    inspect("supabase/functions/ops-api/index.ts", orphanMarkerProbe, entries)
      .length !== 1
  ) {
    failures.push("orphaned marker comment was accepted");
  }
  // Shifting ops-api/index.ts by 50 blank lines at the top must still pass.
  const opsApiFile = "supabase/functions/ops-api/index.ts";
  const opsApiSource = await Deno.readTextFile(new URL(opsApiFile, root));
  const shiftedFailures = inspect(
    opsApiFile,
    "\n".repeat(50) + opsApiSource,
    entries,
  );
  if (shiftedFailures.length !== 0) {
    failures.push(
      `line-shifted ${opsApiFile} failed: ${shiftedFailures.join("; ")}`,
    );
  }
  if (entries.length !== 17) {
    failures.push(`expected 17 rows, got ${entries.length}`);
  }
  if (failures.length) throw new Error(failures.join("\n"));
});
