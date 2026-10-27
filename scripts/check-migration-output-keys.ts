// Migration output-key guard (INT-18; Context audit F5, 26 Oct 2026).
//
// Functions are redefined in full with CREATE OR REPLACE. When two PRs both
// rewrite the same function, the later one silently undoes the other: 1138's
// context_recon_health drops the queue_by_lane key that N1's 20261020155000
// adds. This check fails a PR when a function it (re)defines loses an output
// key that the previous definition had.
//
// "Previous definition" is the last definition of the same function (name and
// input argument types, so overloads stay apart) in any
// migration that sorts before the changed one (apply-pending-migrations.sh
// applies in filename order), or earlier in the same file. "Output keys" are:
//   - OUT / INOUT / TABLE parameter names (RETURNS TABLE (...));
//   - the literal keys of every json_build_object / jsonb_build_object call in
//     the body, nested ones included.
// Dynamic keys (jsonb_object_agg, to_jsonb(row)) are not seen, a function
// built inside an EXECUTE string is not read, and a body that moves its keys
// into a helper function it calls reads as losing them (waive it, below).
//
// An intended removal is allowed only when the new migration says so, once
// per key, in a comment a reviewer will read:
//   -- output-key-guard: drop public.context_recon_health queue_by_lane
//
// Usage (CI): deno run --allow-read --allow-run=git \
//   scripts/check-migration-output-keys.ts --base <sha> [--head <sha>]
// Or name the changed files directly:
//   deno run --allow-read scripts/check-migration-output-keys.ts <file.sql>...
// Exit 0 = no key lost, 1 = a key lost, 2 = usage or read error.

export const MIGRATIONS_DIR = "supabase/migrations";

export interface FunctionDef {
  name: string; // schema-qualified, lower case, with input types: f(int,text)
  keys: Set<string> | null; // null: built dynamically, so not known
  file: string;
  offset: number;
}

export interface LostKeys {
  name: string;
  file: string;
  previousFile: string;
  lost: string[];
}

/** A migration that is applied forward: not a _down rollback, not a draft. */
export function isForwardMigration(path: string): boolean {
  if (!path.endsWith(".sql")) return false;
  const rel = path.startsWith(`${MIGRATIONS_DIR}/`)
    ? path.slice(MIGRATIONS_DIR.length + 1)
    : path.split("/").pop() ?? path;
  if (rel.includes("/")) return false; // _drafts/, contract fixtures
  return !/_down\.sql$/i.test(rel);
}

function qualify(raw: string): string {
  const name = raw.replace(/"/g, "").toLowerCase();
  return name.includes(".") ? name : `public.${name}`;
}

/**
 * Blank out comments and string literals' contents' effect on structure:
 * returns the text with -- and block comments replaced by spaces, so offsets
 * still line up. Dollar-quoted bodies are kept (they are what we read).
 */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && next === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the parenthesis that closes the one at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        i++;
      }
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Split on commas at depth 0 (outside parentheses and quotes). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        i++;
      }
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * The input argument types, so overloads stay apart:
 * "p_since timestamptz DEFAULT now()" and "timestamptz" both give
 * "timestamptz". OUT parameters are not part of the signature.
 */
function inputTypes(list: string): string {
  const types: string[] = [];
  for (const part of splitTopLevel(list)) {
    let p = part.replace(/\s+(DEFAULT\b|=)[\s\S]*$/i, "").trim();
    const mode = p.match(/^(IN|OUT|INOUT|VARIADIC)\s+/i);
    if (mode) {
      if (/^(OUT)$/i.test(mode[1])) continue;
      p = p.slice(mode[0].length);
    }
    const tokens = p.split(/\s+/);
    const type = tokens.length >= 2 ? tokens.slice(1).join(" ") : tokens[0];
    types.push(type.replace(/"/g, "").replace(/^public\./i, "").toLowerCase());
  }
  return types.join(",");
}

/** Names of OUT, INOUT (arguments) or TABLE columns. */
function paramNames(list: string, outOnly: boolean): string[] {
  const names: string[] = [];
  for (const part of splitTopLevel(list)) {
    const m = part.match(/^(IN\s+|OUT\s+|INOUT\s+|VARIADIC\s+)?("?[\w]+"?)\s+\S/i);
    if (!m) continue;
    const mode = (m[1] ?? "").trim().toUpperCase();
    if (outOnly && mode !== "OUT" && mode !== "INOUT") continue;
    names.push(m[2].replace(/"/g, "").toLowerCase());
  }
  return names;
}

/** Literal keys of every json(b)_build_object call in `body`. */
export function jsonKeys(body: string): string[] {
  const keys: string[] = [];
  const re = /\bjsonb?_build_object\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(body, open);
    const args = splitTopLevel(body.slice(open + 1, close - 1));
    for (let i = 0; i < args.length; i += 2) {
      const lit = args[i].match(/^'((?:[^']|'')*)'(?:::text)?$/);
      if (lit) keys.push(lit[1].replace(/''/g, "'"));
    }
  }
  return keys;
}

/**
 * Offsets of text outside any quote: single-quoted strings and dollar-quoted
 * bodies are skipped, so a CREATE FUNCTION inside a DO block's EXECUTE string
 * is not read as a top-level definition.
 */
function topLevelMask(text: string): boolean[] {
  const top = new Array<boolean>(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const tag = text.slice(i).match(/^\$(\w*)\$/);
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? text.length : end + tag[0].length;
        continue;
      }
    }
    top[i] = true;
    i++;
  }
  return top;
}

/**
 * Every function created in one migration, in order. A definition built
 * inside a string (EXECUTE format('CREATE OR REPLACE FUNCTION ...')) cannot
 * be read, so it is recorded with keys null: unknown, never compared.
 */
export function functionDefs(sql: string, file: string): FunctionDef[] {
  const text = stripComments(sql);
  const top = topLevelMask(text);
  const defs: FunctionDef[] = [];
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const argsEnd = closeParen(text, open);
    const name = `${qualify(m[1])}(${inputTypes(text.slice(open + 1, argsEnd - 1))})`;
    if (!top[m.index]) {
      defs.push({ name, keys: null, file, offset: m.index });
      continue;
    }
    const keys = new Set<string>(
      paramNames(text.slice(open + 1, argsEnd - 1), true),
    );
    const rest = text.slice(argsEnd);
    const table = rest.match(/^\s*RETURNS\s+TABLE\s*\(/i);
    if (table) {
      const tOpen = argsEnd + table[0].length - 1;
      const tClose = closeParen(text, tOpen);
      for (const k of paramNames(text.slice(tOpen + 1, tClose - 1), false)) {
        keys.add(k);
      }
    }
    // The body: the first dollar-quoted string after the signature.
    const dollar = rest.match(/\$(\w*)\$/);
    let bodyEnd = argsEnd;
    if (dollar && dollar.index !== undefined) {
      const tag = dollar[0];
      const bodyStart = argsEnd + dollar.index + tag.length;
      const end = text.indexOf(tag, bodyStart);
      const body = text.slice(bodyStart, end === -1 ? text.length : end);
      for (const k of jsonKeys(body)) keys.add(k);
      bodyEnd = end === -1 ? text.length : end + tag.length;
    }
    defs.push({ name, keys, file, offset: m.index });
    re.lastIndex = Math.max(re.lastIndex, bodyEnd);
  }
  return defs;
}

/** `-- output-key-guard: drop <function> <key>` waivers in one migration. */
export function waivers(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /--\s*output-key-guard:\s*drop\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.add(`${qualify(m[1])} ${m[2].toLowerCase()}`);
  }
  return out;
}

/**
 * Compare each function defined in a changed migration with its previous
 * definition. `migrations` maps file name to SQL for every forward migration
 * in the tree being checked (the PR head); `changed` names the PR's files.
 */
export function lostKeys(
  migrations: Map<string, string>,
  changed: string[],
): LostKeys[] {
  const files = [...migrations.keys()].filter(isForwardMigration).sort();
  const changedSet = new Set(changed.filter(isForwardMigration));
  const latest = new Map<string, FunctionDef>();
  const found: LostKeys[] = [];
  for (const file of files) {
    const sql = migrations.get(file) ?? "";
    const allowed = changedSet.has(file) ? waivers(sql) : new Set<string>();
    for (const def of functionDefs(sql, file)) {
      const prev = latest.get(def.name);
      if (changedSet.has(file) && prev?.keys && def.keys) {
        const newKeys = def.keys;
        const lost = [...prev.keys]
          .filter((k) => !newKeys.has(k))
          .filter((k) =>
            !allowed.has(`${def.name.replace(/\(.*$/, "")} ${k.toLowerCase()}`)
          )
          .sort();
        if (lost.length > 0) {
          found.push({
            name: def.name,
            file,
            previousFile: prev.file,
            lost,
          });
        }
      }
      latest.set(def.name, def);
    }
  }
  return found;
}

export function report(found: LostKeys[]): string {
  if (found.length === 0) {
    return "OK output-key guard: no replaced function lost an output key";
  }
  const lines = ["FAIL output-key guard: a replaced function lost output keys"];
  for (const f of found) {
    lines.push(
      `  ${f.file}: ${f.name} drops ${f.lost.join(", ")} (last defined in ${f.previousFile})`,
    );
  }
  lines.push(
    "Rebase the function body onto the previous definition, or, if the removal is",
    "intended, say so in the migration, once per key:",
    "  -- output-key-guard: drop <schema.function> <key>",
  );
  return lines.join("\n");
}

async function git(args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout);
}

async function main(args: string[]): Promise<number> {
  let changed: string[] = [];
  const baseAt = args.indexOf("--base");
  if (baseAt !== -1) {
    const base = args[baseAt + 1];
    const headAt = args.indexOf("--head");
    const head = headAt !== -1 ? args[headAt + 1] : "HEAD";
    if (!base || !head) {
      console.error("Usage: --base <sha> [--head <sha>] | <file.sql>...");
      return 2;
    }
    changed = (await git([
      "diff",
      "--name-only",
      "--diff-filter=AM",
      base,
      head,
      "--",
      `${MIGRATIONS_DIR}/*.sql`,
    ])).split("\n").map((l) => l.trim()).filter(Boolean);
  } else {
    changed = args.filter((a) => a.endsWith(".sql"));
  }
  changed = changed.map((p) =>
    p.startsWith(`${MIGRATIONS_DIR}/`) ? p.slice(MIGRATIONS_DIR.length + 1) : p.split("/").pop()!
  ).filter(isForwardMigration);
  if (changed.length === 0) {
    console.log("OK output-key guard: no forward migration changed");
    return 0;
  }
  const migrations = new Map<string, string>();
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && isForwardMigration(entry.name)) {
      migrations.set(
        entry.name,
        await Deno.readTextFile(`${MIGRATIONS_DIR}/${entry.name}`),
      );
    }
  }
  console.log(`Checked ${changed.length} changed migration(s): ${changed.join(", ")}`);
  const found = lostKeys(migrations, changed);
  const text = report(found);
  if (found.length > 0) {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(`output-key guard could not run: ${(e as Error).message}`);
    Deno.exit(2);
  }
}
