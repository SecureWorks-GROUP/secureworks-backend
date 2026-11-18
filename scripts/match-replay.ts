// Offline replay scorer for supabase/functions/xero-sync/match/decide.ts (P2-13.7).
// Never connects to a database or network. Reads an exported JSON array from disk.
//
// Usage:
//   deno run --allow-read scripts/match-replay.ts <export.json>
//
// Director export query (one read on live from answer_sheet_items and the truth set):
//   WITH clue_types AS (
//     SELECT coalesce(
//       jsonb_object_agg(
//         t.code,
//         jsonb_build_object('code', t.code, 'class', t.class, 'family', t.family, 'mode', t.mode)
//       ),
//       '{}'::jsonb
//     ) AS map
//     FROM public.match_clue_types t
//   ),
//   items AS (
//     SELECT
//       i.subject_id,
//       coalesce(
//         i.snapshot->'clues',
//         (
//           SELECT jsonb_agg(
//             jsonb_build_object(
//               'clue_code', c.clue_code,
//               'class', c.class,
//               'family', c.family,
//               'root', c.root,
//               'outcome', c.outcome,
//               'job_id', c.job_id,
//               'division', c.division,
//               'names_one', c.names_one
//             ) ORDER BY c.id
//           )
//           FROM public.match_clues c
//           WHERE c.subject_kind = i.subject_kind AND c.subject_id = i.subject_id AND c.current
//         ),
//         '[]'::jsonb
//       ) AS clues,
//       i.snapshot->'clue_types' AS snapshot_clue_types,
//       coalesce(i.snapshot->'stops', '[]'::jsonb) AS stops,
//       jsonb_build_object(
//         'outcome', i.answer_outcome->>'outcome',
//         'job_id', i.answer_outcome->>'job_id',
//         'division', i.answer_outcome->>'division'
//       ) AS answer
//     FROM public.answer_sheet_items i
//     WHERE i.answered_at IS NOT NULL
//       AND i.pool IN ('bills', 'receipts_cards')
//     UNION ALL
//     SELECT
//       'xero_bill:' || g.xero_invoice_id AS subject_id,
//       coalesce(
//         (
//           SELECT jsonb_agg(
//             jsonb_build_object(
//               'clue_code', c.clue_code,
//               'class', c.class,
//               'family', c.family,
//               'root', c.root,
//               'outcome', c.outcome,
//               'job_id', c.job_id,
//               'division', c.division,
//               'names_one', c.names_one
//             ) ORDER BY c.id
//           )
//           FROM public.match_clues c
//           WHERE c.subject_kind = 'cost_document'
//             AND c.subject_id = 'xero_bill:' || g.xero_invoice_id
//             AND c.current
//         ),
//         '[]'::jsonb
//       ) AS clues,
//       NULL::jsonb AS snapshot_clue_types,
//       coalesce(
//         (
//           SELECT coalesce(s.stops, '[]'::jsonb)
//           FROM public.match_shadow_runs s
//           WHERE s.subject_kind = 'cost_document'
//             AND s.subject_id = 'xero_bill:' || g.xero_invoice_id
//           ORDER BY s.created_at DESC, s.id DESC
//           LIMIT 1
//         ),
//         '[]'::jsonb
//       ) AS stops,
//       jsonb_build_object(
//         'outcome', CASE g.answer
//           WHEN 'job' THEN 'job'
//           WHEN 'unsure' THEN 'unsure'
//           WHEN 'split' THEN 'split'
//           WHEN 'non_job' THEN CASE WHEN g.non_job_bucket = 'stock' THEN 'division_stock' ELSE 'overhead' END
//         END,
//         'job_id', CASE WHEN g.answer = 'job' THEN g.answer_job_ids[1]::text END,
//         'division', NULL
//       ) AS answer
//     FROM public.context_truth_set_grades g
//     WHERE g.kind = 'bill'
//   )
//   SELECT coalesce(
//     jsonb_agg(
//       jsonb_build_object(
//         'subject_id', items.subject_id,
//         'clues', items.clues,
//         'clue_types', coalesce(items.snapshot_clue_types, clue_types.map),
//         'stops', items.stops,
//         'answer', items.answer
//       ) ORDER BY items.subject_id COLLATE "C"
//     ),
//     '[]'::jsonb
//   )
//   FROM items CROSS JOIN clue_types;

import { decideMatch } from "../supabase/functions/xero-sync/match/decide.ts";
import type {
  Clue,
  ClueType,
  MatchResult,
  Stop,
} from "../supabase/functions/xero-sync/match/types.ts";

export type ReplayAnswerOutcome =
  | "job"
  | "overhead"
  | "division_stock"
  | "split"
  | "unsure";

export interface ReplayAnswer {
  outcome: ReplayAnswerOutcome;
  job_id?: string | null;
  division?: string | null;
}

export interface ReplayItem {
  subject_id: string;
  clues: Clue[];
  clue_types: Record<string, ClueType>;
  stops: Stop[];
  answer: ReplayAnswer;
}

export interface ReplayScore {
  items: number;
  auto_right: number;
  auto_wrong: number;
  suggest_right: number;
  suggest_wrong: number;
  none: number;
  auto_wrong_subjects: string[];
}

const CLUE_CLASSES = new Set(["key", "clue", "narrower", "ai"]);
const CLUE_OUTCOMES = new Set(["job", "overhead", "division_stock"]);
const CLUE_MODES = new Set(["counts", "suggest_only", "off"]);
const ANSWER_OUTCOMES = new Set([
  "job",
  "overhead",
  "division_stock",
  "split",
  "unsure",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonEmptyString(
  value: unknown,
  code: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(code);
  }
  return value;
}

function parseClue(raw: unknown, itemRef: string): Clue {
  if (!isRecord(raw)) {
    throw new Error(`replay_invalid_clue:${itemRef}`);
  }
  if (
    typeof raw.clue_code !== "string" || raw.clue_code.trim().length === 0 ||
    typeof raw.class !== "string" || !CLUE_CLASSES.has(raw.class) ||
    typeof raw.family !== "string" || raw.family.trim().length === 0 ||
    typeof raw.root !== "string" || raw.root.trim().length === 0 ||
    typeof raw.outcome !== "string" || !CLUE_OUTCOMES.has(raw.outcome) ||
    typeof raw.names_one !== "boolean"
  ) {
    throw new Error(`replay_invalid_clue:${itemRef}`);
  }
  const jobId = optionalNonEmptyString(
    raw.job_id,
    `replay_invalid_clue_job:${itemRef}`,
  );
  const division = optionalNonEmptyString(
    raw.division,
    `replay_invalid_clue_division:${itemRef}`,
  );
  return {
    clue_code: raw.clue_code,
    class: raw.class as Clue["class"],
    family: raw.family,
    root: raw.root,
    outcome: raw.outcome as Clue["outcome"],
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    ...(division !== undefined ? { division } : {}),
    names_one: raw.names_one,
  };
}

function parseClueTypeEntry(
  raw: unknown,
  fallbackCode: string | null,
  itemRef: string,
): ClueType {
  if (!isRecord(raw)) {
    throw new Error(`replay_invalid_clue_type:${itemRef}`);
  }
  const code = typeof raw.code === "string" && raw.code.trim().length > 0
    ? raw.code
    : fallbackCode;
  if (
    !code ||
    typeof raw.class !== "string" || !CLUE_CLASSES.has(raw.class) ||
    typeof raw.family !== "string" || raw.family.trim().length === 0 ||
    typeof raw.mode !== "string" || !CLUE_MODES.has(raw.mode)
  ) {
    throw new Error(`replay_invalid_clue_type:${itemRef}`);
  }
  return {
    code,
    class: raw.class as ClueType["class"],
    family: raw.family,
    mode: raw.mode as ClueType["mode"],
  };
}

function parseClueTypes(
  raw: unknown,
  itemRef: string,
): Record<string, ClueType> {
  if (Array.isArray(raw)) {
    const out: Record<string, ClueType> = {};
    for (const entry of raw) {
      const parsed = parseClueTypeEntry(entry, null, itemRef);
      out[parsed.code] = parsed;
    }
    return out;
  }
  if (!isRecord(raw)) {
    throw new Error(`replay_invalid_clue_types:${itemRef}`);
  }
  const out: Record<string, ClueType> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key.trim().length === 0) {
      throw new Error(`replay_invalid_clue_type:${itemRef}`);
    }
    const parsed = parseClueTypeEntry(entry, key, itemRef);
    out[key] = parsed;
  }
  return out;
}

function parseStop(raw: unknown, itemRef: string): Stop {
  if (
    !isRecord(raw) ||
    typeof raw.code !== "string" || raw.code.trim().length === 0
  ) {
    throw new Error(`replay_invalid_stop:${itemRef}`);
  }
  return {
    code: raw.code,
    words: typeof raw.words === "string" ? raw.words : raw.code,
  };
}

function parseAnswer(raw: unknown, itemRef: string): ReplayAnswer {
  if (
    !isRecord(raw) ||
    typeof raw.outcome !== "string" ||
    !ANSWER_OUTCOMES.has(raw.outcome)
  ) {
    throw new Error(`replay_invalid_answer:${itemRef}`);
  }
  const jobId = optionalNonEmptyString(
    raw.job_id,
    `replay_invalid_answer_job:${itemRef}`,
  );
  const division = optionalNonEmptyString(
    raw.division,
    `replay_invalid_answer_division:${itemRef}`,
  );
  if (raw.outcome === "job" && jobId === undefined) {
    throw new Error(`replay_missing_answer_job:${itemRef}`);
  }
  return {
    outcome: raw.outcome as ReplayAnswerOutcome,
    job_id: jobId ?? null,
    division: division ?? null,
  };
}

export function parseReplayItems(raw: unknown): ReplayItem[] {
  if (!Array.isArray(raw)) {
    throw new Error("replay_items_not_array");
  }
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.subject_id !== "string" ||
      entry.subject_id.trim().length === 0
    ) {
      throw new Error(`replay_invalid_subject:index_${index}`);
    }
    const subjectId = entry.subject_id;
    if (!Array.isArray(entry.clues)) {
      throw new Error(`replay_clues_not_array:${subjectId}`);
    }
    if (!Array.isArray(entry.stops)) {
      throw new Error(`replay_stops_not_array:${subjectId}`);
    }
    return {
      subject_id: subjectId,
      clues: entry.clues.map((c) => parseClue(c, subjectId)),
      clue_types: parseClueTypes(entry.clue_types, subjectId),
      stops: entry.stops.map((s) => parseStop(s, subjectId)),
      answer: parseAnswer(entry.answer, subjectId),
    };
  });
}

function decisionMatchesAnswer(
  decision: MatchResult,
  answer: ReplayAnswer,
): boolean {
  if (decision.result === "auto") {
    return answer.outcome === "job" &&
      typeof answer.job_id === "string" &&
      answer.job_id.length > 0 &&
      decision.job_id === answer.job_id;
  }
  if (decision.result === "suggest" && decision.outcome !== undefined) {
    if (decision.outcome === "job") {
      return answer.outcome === "job" &&
        typeof answer.job_id === "string" &&
        answer.job_id.length > 0 &&
        typeof decision.job_id === "string" &&
        decision.job_id === answer.job_id;
    }
    if (decision.outcome === "overhead") {
      return answer.outcome === "overhead";
    }
    if (decision.outcome === "division_stock") {
      return answer.outcome === "division_stock" &&
        typeof answer.division === "string" &&
        answer.division.length > 0 &&
        typeof decision.division === "string" &&
        decision.division === answer.division;
    }
  }
  return false;
}

export function scoreReplay(items: ReplayItem[]): ReplayScore {
  let scored = 0;
  let autoRight = 0;
  let autoWrong = 0;
  let suggestRight = 0;
  let suggestWrong = 0;
  let none = 0;
  const autoWrongSubjects: string[] = [];

  for (const item of items) {
    if (item.answer.outcome === "unsure") continue;
    scored++;
    const decision = decideMatch(item.clues, item.clue_types, item.stops);
    if (decision.result === "auto") {
      if (decisionMatchesAnswer(decision, item.answer)) {
        autoRight++;
      } else {
        autoWrong++;
        autoWrongSubjects.push(item.subject_id);
      }
    } else if (
      decision.result === "suggest" && decision.outcome !== undefined
    ) {
      if (decisionMatchesAnswer(decision, item.answer)) {
        suggestRight++;
      } else {
        suggestWrong++;
      }
    } else {
      none++;
    }
  }

  return {
    items: scored,
    auto_right: autoRight,
    auto_wrong: autoWrong,
    suggest_right: suggestRight,
    suggest_wrong: suggestWrong,
    none,
    auto_wrong_subjects: autoWrongSubjects,
  };
}

export function formatReplayScore(score: ReplayScore): string {
  return JSON.stringify(score, null, 2);
}

export async function runMatchReplayCli(
  args: string[],
  io: { stdout?: (line: string) => void; stderr?: (line: string) => void } = {},
): Promise<number> {
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  const filePath = args[0];
  if (!filePath || filePath.trim().length === 0) {
    err("replay_error:replay_path_required");
    return 2;
  }
  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch {
    err("replay_error:replay_read_failed");
    return 2;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    err("replay_error:replay_invalid_json");
    return 2;
  }
  let items: ReplayItem[];
  try {
    items = parseReplayItems(parsedJson);
  } catch (e) {
    const code = e instanceof Error ? e.message : "replay_invalid_input";
    err(`replay_error:${code}`);
    return 2;
  }
  const score = scoreReplay(items);
  out(formatReplayScore(score));
  return score.auto_wrong > 0 ? 1 : 0;
}

if (import.meta.main) {
  const code = await runMatchReplayCli(Deno.args);
  Deno.exit(code);
}
