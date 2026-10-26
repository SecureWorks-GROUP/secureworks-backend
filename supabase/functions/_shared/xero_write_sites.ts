// deno-lint-ignore-file no-import-prefix
// Finds every Xero write call site in the edge function sources (INT-33).
//
// A source scan with the TypeScript parser, not a runtime hook. It reads
// every non-test .ts file under supabase/functions and reports each place
// that can write to Xero:
//   - transport_call: a call to an `xeroPost` transport (ops-api's,
//     xero-sync's, or one passed in as `deps.xeroPost` / `_xeroPost`);
//   - direct_fetch: a fetch to a Xero accounting URL with PUT, POST or DELETE;
//   - xero_sync_action: an HTTP call to a xero-sync action that writes.
// Each site gets a stable key, `file :: enclosing :: METHOD /Path`, where
// enclosing is the nearest named function or ops-api `case`, so a line
// moving does not change it. The register (xero_write_register.json) names
// the X row every key belongs to; xero_write_register_test.ts fails when a
// site appears that the register does not name, or it names one that is gone.

import ts from "npm:typescript@5.6.3";

export type XeroWriteSite = {
  key: string;
  file: string;
  line: number;
  enclosing: string;
  method: string;
  path: string;
  kind: "transport_call" | "direct_fetch" | "xero_sync_action";
};

const TRANSPORT_NAMES = new Set(["xeroPost", "_xeroPost"]);
const XERO_BASES = [
  /^https:\/\/api\.xero\.com\/api\.xro\/2\.0/,
  /^\$\{(?:env\.|opts\.)?(?:XERO_API_BASE|baseUrl)\}/,
];
const SYNC_WRITE_ACTIONS = ["create_or_find_contact"];
const WRITE_METHODS = new Set(["PUT", "POST", "DELETE"]);

/** A template or string literal's text, with each `${...}` kept verbatim. */
function literalText(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.getText(sf).slice(1, -1);
  }
  return null;
}

/** Normalise a Xero path: `${...}` becomes {id}, the base and query go. */
export function normalisePath(raw: string): string {
  let p = raw;
  for (const base of XERO_BASES) p = p.replace(base, "");
  // Replace ${...} with {id}, allowing one level of nested braces.
  p = p.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "{id}");
  p = p.split("?")[0];
  return p || "{dynamic}";
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

// The nearest named function or ops-api `case`. A method of an object (a
// gateway's `authorise`) is named with the function that makes the object:
// `makeSesXeroGateway.authorise`.
function enclosingName(node: ts.Node): string {
  let inner: string | null = null;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    let name: string | null = null;
    let isMember = false;
    if (ts.isCaseClause(p) && ts.isStringLiteral(p.expression)) {
      name = `case ${p.expression.text}`;
    } else if (ts.isFunctionDeclaration(p) && p.name) {
      name = p.name.text;
    } else if (ts.isMethodDeclaration(p) && p.name) {
      name = p.name.getText();
      isMember = true;
    } else if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const host = p.parent;
      if (
        host && ts.isVariableDeclaration(host) && ts.isIdentifier(host.name)
      ) {
        name = host.name.text;
      } else if (host && ts.isPropertyAssignment(host)) {
        name = host.name.getText();
        isMember = true;
      } else if (ts.isFunctionExpression(p) && p.name) {
        name = p.name.text;
      }
    }
    if (!name) continue;
    if (inner) return `${name}.${inner}`;
    if (!isMember) return name;
    inner = name;
  }
  return inner ?? "(module)";
}

function methodOf(args: readonly ts.Expression[]): string | null {
  for (const a of args) {
    if (ts.isStringLiteral(a) && WRITE_METHODS.has(a.text)) return a.text;
    if (ts.isObjectLiteralExpression(a)) {
      for (const prop of a.properties) {
        if (
          ts.isPropertyAssignment(prop) && prop.name.getText() === "method" &&
          ts.isStringLiteral(prop.initializer)
        ) {
          return prop.initializer.text.toUpperCase();
        }
      }
    }
  }
  return null;
}

/** Every Xero write site in one file's source. */
export function scanSource(file: string, source: string): XeroWriteSite[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sites: Omit<XeroWriteSite, "key">[] = [];
  const lineOf = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const args = node.arguments;
      if (name && TRANSPORT_NAMES.has(name) && args.length > 0) {
        const raw = literalText(args[0], sf);
        sites.push({
          file,
          line: lineOf(node),
          enclosing: enclosingName(node),
          // Both transports default to POST.
          method: methodOf(args.slice(1)) ?? "POST",
          path: raw === null ? `{${args[0].getText(sf)}}` : normalisePath(raw),
          kind: "transport_call",
        });
      } else if (name && /fetch/i.test(name) && args.length > 0) {
        const raw = literalText(args[0], sf);
        const method = methodOf(args.slice(1));
        if (raw !== null && method && WRITE_METHODS.has(method)) {
          if (XERO_BASES.some((b) => b.test(raw))) {
            sites.push({
              file,
              line: lineOf(node),
              enclosing: enclosingName(node),
              method,
              path: normalisePath(raw),
              kind: "direct_fetch",
            });
          }
        }
        if (raw !== null) {
          for (const action of SYNC_WRITE_ACTIONS) {
            if (raw.includes(`/functions/v1/xero-sync?action=${action}`)) {
              sites.push({
                file,
                line: lineOf(node),
                enclosing: enclosingName(node),
                method: method ?? "POST",
                path: `xero-sync:${action}`,
                kind: "xero_sync_action",
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Stable keys; a repeat within one enclosing block gets #2, #3 in order.
  sites.sort((a, b) => a.line - b.line);
  const seen = new Map<string, number>();
  return sites.map((s) => {
    const base = `${s.file} :: ${s.enclosing} :: ${s.method} ${s.path}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...s, key: n === 1 ? base : `${base} #${n}` };
  });
}

/** Every non-test .ts file under `root` (supabase/functions), relative paths. */
export async function listSources(root: URL): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: URL, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === "fixtures") continue;
        await walk(new URL(`${e.name}/`, dir), childRel);
      } else if (
        e.isFile && e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") &&
        !/test_(support|fake|helpers)|_test_/.test(e.name)
      ) {
        out.push(childRel);
      }
    }
  };
  await walk(root, "");
  return out.sort();
}

/** Every Xero write site under supabase/functions. */
export async function scanFunctions(root: URL): Promise<XeroWriteSite[]> {
  const sites: XeroWriteSite[] = [];
  for (const rel of await listSources(root)) {
    const src = await Deno.readTextFile(new URL(rel, root));
    if (!/xero/i.test(src)) continue;
    sites.push(...scanSource(rel, src));
  }
  return sites;
}
