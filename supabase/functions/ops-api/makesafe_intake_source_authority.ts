export interface IntakeSourceAuthoritySourceRow {
  case_id: string;
  post_id: string;
}

export interface IntakeSourceAuthorityCorrectionRow {
  id: string;
  source_post_id: string;
  legacy_case_id: string | null;
  effective_case_id: string | null;
  target_job_id: string | null;
}

export interface IntakeSourceAuthoritySupersessionRow {
  source_post_id: string;
  superseded_correction_id: string;
  prior_authority_case_id: string;
  effective_case_id: string;
}

export interface EffectiveIntakeSourceAuthority<
  TSource extends IntakeSourceAuthoritySourceRow,
> {
  source: TSource;
  storedCaseId: string;
  effectiveCaseId: string | null;
  targetJobId: string | null;
}

/**
 * Apply the append-only source correction and supersession ledgers in order.
 * This is the canonical source-authority overlay for intake read/write gates.
 */
export function resolveEffectiveIntakeSourceAuthority<
  TSource extends IntakeSourceAuthoritySourceRow,
>(
  sources: TSource[],
  sourceCorrections: IntakeSourceAuthorityCorrectionRow[],
  sourceSupersessions: IntakeSourceAuthoritySupersessionRow[],
): EffectiveIntakeSourceAuthority<TSource>[] {
  const storedCaseByPost = new Map<string, string>();
  for (const source of sources) {
    const prior = storedCaseByPost.get(source.post_id);
    if (prior && prior !== source.case_id) {
      throw new Error(
        `intake source authority is not unique for post ${source.post_id}`,
      );
    }
    storedCaseByPost.set(source.post_id, source.case_id);
  }

  const correctionByPost = new Map<
    string,
    IntakeSourceAuthorityCorrectionRow
  >();
  for (const correction of sourceCorrections) {
    if (correctionByPost.has(correction.source_post_id)) {
      throw new Error(
        `intake source correction is not unique for post ${correction.source_post_id}`,
      );
    }
    const stored = storedCaseByPost.get(correction.source_post_id) || null;
    if (correction.legacy_case_id && stored !== correction.legacy_case_id) {
      throw new Error("intake source correction legacy authority mismatch");
    }
    correctionByPost.set(correction.source_post_id, correction);
  }

  const supersessionByPost = new Map<
    string,
    IntakeSourceAuthoritySupersessionRow
  >();
  for (const supersession of sourceSupersessions) {
    if (supersessionByPost.has(supersession.source_post_id)) {
      throw new Error(
        `intake source supersession is not unique for post ${supersession.source_post_id}`,
      );
    }
    supersessionByPost.set(supersession.source_post_id, supersession);
  }

  return sources.map((source) => {
    const correction = correctionByPost.get(source.post_id) || null;
    // NULL deliberately clears case authority when target_job_id accounts the
    // source; never collapse that reviewed result back to the stored case.
    let effectiveCaseId: string | null = correction
      ? correction.effective_case_id
      : source.case_id;
    const supersession = supersessionByPost.get(source.post_id) || null;
    if (supersession) {
      if (
        !correction ||
        correction.id !== supersession.superseded_correction_id
      ) {
        throw new Error("intake source supersession target mismatch");
      }
      if (effectiveCaseId !== supersession.prior_authority_case_id) {
        throw new Error("intake source supersession prior authority mismatch");
      }
      effectiveCaseId = supersession.effective_case_id;
    }
    return {
      source,
      storedCaseId: source.case_id,
      effectiveCaseId,
      targetJobId: correction?.target_job_id || null,
    };
  });
}
