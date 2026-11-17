import type { Clue, ClueType, MatchResult, Stop } from "./types.ts";

/** Two independent, enabled clues may place a job. Everything else needs a person. */
export function decideMatch(
  clues: Clue[],
  types: Record<string, ClueType>,
  stops: Stop[],
): MatchResult {
  const counting = clues.map((clue, index) => ({ clue, index })).filter((
    { clue },
  ) => (clue.class === "key" || clue.class === "clue") && clue.names_one);
  const best = counting.find(({ clue }) => clue.class === "key") ??
    counting.find(({ clue }) => clue.class === "clue") ??
    clues.map((clue, index) => ({ clue, index })).find(({ clue }) =>
      clue.class === "ai"
    );
  const suggest = (reason: string): MatchResult => ({
    result: "suggest",
    reason,
    ...(best
      ? {
        outcome: best.clue.outcome,
        ...(best.clue.outcome === "job" && best.clue.job_id
          ? { job_id: best.clue.job_id }
          : {}),
        ...(best.clue.division ? { division: best.clue.division } : {}),
        from_clue_index: best.index,
      }
      : {}),
  });
  if (
    !clues.some((clue) =>
      clue.class === "key" || clue.class === "clue" || clue.class === "ai"
    )
  ) {
    return stops.length
      ? { result: "suggest", reason: stops[0].code }
      : { result: "none", reason: "no_clue" };
  }
  if (stops.length) return suggest(stops[0].code);
  const outcomes = new Set(
    counting.map(({ clue }) =>
      JSON.stringify([
        clue.outcome,
        clue.outcome === "job" ? clue.job_id : clue.division,
      ])
    ),
  );
  if (outcomes.size > 1) return { result: "suggest", reason: "two_jobs_named" };
  for (let a = 0; a < counting.length; a++) {
    for (let b = a + 1; b < counting.length; b++) {
      const A = counting[a].clue;
      const B = counting[b].clue;
      if (
        A.outcome === "job" && B.outcome === "job" && A.job_id &&
        A.job_id === B.job_id &&
        types[A.clue_code]?.mode === "counts" &&
        types[B.clue_code]?.mode === "counts" &&
        A.family !== B.family && A.root !== B.root
      ) {
        return {
          result: "auto",
          job_id: A.job_id,
          clue_indexes: [counting[a].index, counting[b].index],
        };
      }
    }
  }
  return suggest(counting.length ? "one_clue" : "ai_only");
}
