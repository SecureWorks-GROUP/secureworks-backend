import type { SesSha256 } from "./ses_docket_envelope.ts";

export const SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION =
  "ses-workflow-source-closure/2026-08-15.1";

export type SesWorkflowExecutableSurface =
  | "family"
  | "stage"
  | "pack"
  | "pricing"
  | "send";

export interface SesWorkflowExecutableEntryPoint {
  surface: SesWorkflowExecutableSurface;
  module: string;
  symbols: readonly string[];
}

/**
 * Named executable roots whose behaviour the SES workflow contract attests.
 * The source closure is discovered from these roots; this list names only the
 * public behaviour boundary and never enumerates its transitive dependencies.
 */
export const SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS = Object.freeze(
  [
    {
      surface: "family",
      module: "ses_family_matrix.ts",
      symbols: ["canonicalSesFamilyFromCard", "resolveSesFamilyMatrixRow"],
    },
    {
      surface: "family",
      module: "ses_workflow_executable_policy.ts",
      symbols: ["sesWorkflowExecutableFamilyPolicy"],
    },
    {
      surface: "stage",
      module: "ses_stage_engine_v2.ts",
      symbols: [
        "deriveSesStageV2",
        "sesStageDocsReady",
        "sesStageWorkflowProfile",
      ],
    },
    {
      surface: "pack",
      module: "ses_assembler_input_adapter.ts",
      symbols: [
        "buildSesAssemblerInput",
        "createSesAssemblerRuntimeDependencies",
        "normalizeSesPrepareRequest",
      ],
    },
    {
      surface: "pack",
      module: "ses_prepare_docket_revision.ts",
      symbols: [
        "prepare_ses_docket_revision",
        "sesWorkflowPackProfile",
        "sesWorkflowPricingProfile",
      ],
    },
    {
      surface: "pricing",
      module: "ses_materials_rate_card.ts",
      symbols: ["priceRecordedMaterialsFromRateCard"],
    },
    {
      surface: "pricing",
      module: "ses_materials_charge_guard.ts",
      symbols: ["decideStandardLabourMaterialsCharge"],
    },
    {
      surface: "send",
      module: "ses_release_route_shape.ts",
      symbols: ["resolveSesWorkflowRoutes", "sesWorkflowSendProfile"],
    },
    {
      surface: "send",
      module: "ses_unified_release.ts",
      symbols: [
        "assertSesAuthorisedReleaseRouteDerivative",
        "deriveSesAuthorisedReleaseRoutes",
        "runUnifiedSesRelease",
      ],
    },
  ] as const satisfies readonly SesWorkflowExecutableEntryPoint[],
);

/**
 * Boundary rule: follow every static local TypeScript import reachable from
 * the named roots while it remains below `ops-api/`. Remote, npm/jsr, vendored,
 * generated, unreachable test-only and non-TypeScript resources are outside
 * this source attestation. The pinned contract coordinate therefore lives in
 * a JSON lock, outside the TypeScript closure, so the registry and this walker
 * are both fingerprinted without a recursive source-hash literal. The focused
 * test compares this walk with Deno's module graph, so an import syntax the
 * walker does not understand fails closed.
 */
export interface SesWorkflowExecutableSourceClosure {
  boundary_version: typeof SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION;
  entry_points: readonly SesWorkflowExecutableEntryPoint[];
  module_count: number;
  modules: Readonly<Record<string, SesSha256>>;
  closure_sha256: SesSha256;
}

export type SesWorkflowSourceReader = (url: URL) => Promise<Uint8Array>;

interface ReadStringResult {
  value: string;
  end: number;
}

const OPS_API_ROOT_URL = new URL("./", import.meta.url);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return end === -1 ? source.length : skipTrivia(source, end + 2);
    }
    break;
  }
  return index;
}

function readQuotedString(
  source: string,
  start: number,
): ReadStringResult | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === "\\") {
      if (index + 1 >= source.length) return null;
      value += source[index + 1];
      index++;
      continue;
    }
    if (character === quote) return { value, end: index + 1 };
    value += character;
  }
  return null;
}

function readIdentifier(
  source: string,
  start: number,
): { value: string; end: number } | null {
  if (!isIdentifierStart(source[start] || "")) return null;
  let end = start + 1;
  while (end < source.length && isIdentifierPart(source[end])) end++;
  return { value: source.slice(start, end), end };
}

function skipNonCodeLiteral(source: string, start: number): number {
  const quoted = readQuotedString(source, start);
  if (quoted) return quoted.end;
  if (source[start] !== "`") return start + 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === "`") return index + 1;
  }
  return source.length;
}

function findFromSpecifier(
  source: string,
  start: number,
): { specifier: string | null; end: number } {
  let index = start;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length || source[index] === ";") {
      return { specifier: null, end: Math.min(index + 1, source.length) };
    }
    if (
      source[index] === '"' || source[index] === "'" ||
      source[index] === "`"
    ) {
      index = skipNonCodeLiteral(source, index);
      continue;
    }
    const identifier = readIdentifier(source, index);
    if (!identifier) {
      index++;
      continue;
    }
    index = identifier.end;
    if (identifier.value !== "from") continue;
    index = skipTrivia(source, index);
    const quoted = readQuotedString(source, index);
    return quoted
      ? { specifier: quoted.value, end: quoted.end }
      : { specifier: null, end: index };
  }
  return { specifier: null, end: source.length };
}

/** Static import/re-export scanner used by the runtime closure walk. */
export function sesWorkflowStaticModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  let index = 0;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length) break;
    if (
      source[index] === '"' || source[index] === "'" ||
      source[index] === "`"
    ) {
      index = skipNonCodeLiteral(source, index);
      continue;
    }
    const identifier = readIdentifier(source, index);
    if (!identifier) {
      index++;
      continue;
    }
    index = identifier.end;
    if (identifier.value === "import") {
      index = skipTrivia(source, index);
      if (source[index] === "(") {
        index = skipTrivia(source, index + 1);
        const dynamic = readQuotedString(source, index);
        if (dynamic) {
          specifiers.add(dynamic.value);
          index = dynamic.end;
        }
        continue;
      }
      const sideEffect = readQuotedString(source, index);
      if (sideEffect) {
        specifiers.add(sideEffect.value);
        index = sideEffect.end;
        continue;
      }
      const imported = findFromSpecifier(source, index);
      if (imported.specifier) specifiers.add(imported.specifier);
      index = imported.end;
      continue;
    }
    if (identifier.value !== "export") continue;
    index = skipTrivia(source, index);
    const next = readIdentifier(source, index);
    if (next?.value === "type") index = skipTrivia(source, next.end);
    if (source[index] !== "{" && source[index] !== "*") continue;
    const exported = findFromSpecifier(source, index);
    if (exported.specifier) specifiers.add(exported.specifier);
    index = exported.end;
  }
  return [...specifiers].sort();
}

export function sesWorkflowSourceClosureModuleName(
  url: URL,
  rootUrl: URL = OPS_API_ROOT_URL,
): string | null {
  if (!url.href.startsWith(rootUrl.href)) return null;
  const relative = decodeURIComponent(url.href.slice(rootUrl.href.length));
  if (
    !relative || relative.startsWith("../") || !relative.endsWith(".ts")
  ) {
    return null;
  }
  return relative;
}

async function sha256Bytes(bytes: Uint8Array): Promise<SesSha256> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return `sha256:${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

export async function computeSesWorkflowExecutableSourceClosure(
  options: {
    readSource?: SesWorkflowSourceReader;
    rootUrl?: URL;
  } = {},
): Promise<SesWorkflowExecutableSourceClosure> {
  const rootUrl = options.rootUrl ?? OPS_API_ROOT_URL;
  const readSource = options.readSource ?? ((url: URL) => Deno.readFile(url));
  const pending = SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS.map((entry) =>
    new URL(entry.module, rootUrl)
  );
  const sourceByModule = new Map<string, Uint8Array>();

  while (pending.length) {
    const url = pending.pop() as URL;
    const moduleName = sesWorkflowSourceClosureModuleName(url, rootUrl);
    if (!moduleName || sourceByModule.has(moduleName)) continue;
    const sourceBytes = await readSource(url);
    sourceByModule.set(moduleName, sourceBytes);
    for (
      const specifier of sesWorkflowStaticModuleSpecifiers(
        textDecoder.decode(sourceBytes),
      )
    ) {
      if (!specifier.startsWith(".")) continue;
      const dependency = new URL(specifier, url);
      if (sesWorkflowSourceClosureModuleName(dependency, rootUrl)) {
        pending.push(dependency);
      }
    }
  }

  const modules = Object.fromEntries(
    await Promise.all(
      [...sourceByModule.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      ).map(async ([moduleName, sourceBytes]) =>
        [moduleName, await sha256Bytes(sourceBytes)] as const
      ),
    ),
  ) as Record<string, SesSha256>;
  const closureDigestInput = [
    `${SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION}\n`,
    ...Object.entries(modules).map(([name, digest]) => `${name}\0${digest}\n`),
  ].join("");

  return Object.freeze({
    boundary_version: SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION,
    entry_points: SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS,
    module_count: Object.keys(modules).length,
    modules: Object.freeze(modules),
    closure_sha256: await sha256Bytes(textEncoder.encode(closureDigestInput)),
  });
}

let executableSourceClosurePromise:
  | Promise<SesWorkflowExecutableSourceClosure>
  | undefined;

/** Cached once per Edge isolate; source files are immutable within an isolate. */
export function sesWorkflowExecutableSourceClosure(): Promise<
  SesWorkflowExecutableSourceClosure
> {
  executableSourceClosurePromise ??=
    computeSesWorkflowExecutableSourceClosure();
  return executableSourceClosurePromise;
}
