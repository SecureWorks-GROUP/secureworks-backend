type Site = { file: string; line: number[]; function: string[] };
type Entry = Site & {
  id: number;
  repo: string;
  provider: string;
  model: string;
  what: string;
  runs: string;
  fate: string;
  safe_without_key: string;
  other_repository_sites: Site[];
};

const root = new URL("../../../", import.meta.url);
const entries: Entry[] = JSON.parse(
  await Deno.readTextFile(new URL("paid_ai_register.json", import.meta.url)),
);
const marker =
  /api\.anthropic\.com|api\.openai\.com|new Anthropic\(|new OpenAI\(/;

// Anchors are deliberately exact. Moving a call requires updating the inventory,
// and adding another call inside an already listed function requires listing it.
export function inspect(
  file: string,
  source: string,
  register: Entry[] = entries,
): string[] {
  const failures: string[] = [];
  let owner = "<module>";
  source.split("\n").forEach((line, index) => {
    const declaration = line.match(
      /^(?:export )?(?:async )?function\s+(\w+)\s*\(/,
    );
    if (declaration) owner = declaration[1];
    if (/^serve\(async\s*\(/.test(line)) owner = "<request handler>";
    if (!marker.test(line)) return;
    const allowed = register.some((entry) =>
      entry.repo === "B" && entry.file === file &&
      entry.line.some((n, i) => n === index + 1 && entry.function[i] === owner)
    );
    if (!allowed) {
      failures.push(
        `${file}:${index + 1} (${owner}): unregistered paid AI marker`,
      );
    }
  });
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
  for await (const url of sources(new URL("supabase/functions/", root))) {
    const file = decodeURIComponent(url.pathname.slice(root.pathname.length));
    failures.push(...inspect(file, await Deno.readTextFile(url), entries));
  }
  const doc = await Deno.readTextFile(new URL("docs/paid-ai-callers.md", root));
  for (const entry of entries) {
    const location = `${entry.file}:${entry.line.join(",")}`;
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
      const lines = (await Deno.readTextFile(new URL(entry.file, root))).split(
        "\n",
      );
      for (const n of entry.line) {
        if (!marker.test(lines[n - 1] || "")) {
          failures.push(`${entry.file}:${n}: stale anchor`);
        }
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
  // A virtual temporary source keeps the proof runnable with --allow-read only.
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
  if (entries.length !== 17) {
    failures.push(`expected 17 rows, got ${entries.length}`);
  }
  if (failures.length) throw new Error(failures.join("\n"));
});
