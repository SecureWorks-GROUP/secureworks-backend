type Refusal = {
  status: 400;
  body: { success: false; code: string; error: string };
};

function refuse(code: string, error: string): Refusal {
  return { status: 400, body: { success: false, code, error } };
}

/** This endpoint publishes all stored runs; it has no selected-run contract. */
export function sendRunsRequestRefusal(body: unknown): Refusal | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(
      "INVALID_QUOTE_SEND_REQUEST",
      "A quote send request object is required",
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, "runs")) {
    return refuse(
      "RUN_SELECTION_NOT_SUPPORTED",
      "Run selection is not supported. This endpoint sends all stored runs; omit runs only when that full send is intended.",
    );
  }
  const request = body as Record<string, unknown>;
  if (typeof request.job_id !== "string" || !request.job_id.trim()) {
    return refuse("INVALID_QUOTE_SEND_REQUEST", "job_id required");
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "expected_job_type") &&
    request.expected_job_type !== "fencing"
  ) {
    return refuse(
      "INVALID_QUOTE_SEND_REQUEST",
      "expected_job_type must be fencing when supplied",
    );
  }
  return null;
}

/** Optional caller scope check; legacy send-runs clients retain their behavior. */
export function sendRunsJobTypeRefusal(
  body: Record<string, unknown>,
  jobType: unknown,
): Refusal | null {
  if (body.expected_job_type === "fencing" && jobType !== "fencing") {
    return refuse(
      "QUOTE_JOB_TYPE_MISMATCH",
      "This quote send request requires a fencing job. No quote was sent.",
    );
  }
  return null;
}
