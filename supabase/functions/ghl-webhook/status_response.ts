/** A resolved fetch is not a completed status write. Keep failures visible. */
export function assertStatusUpdateResponse(
  response: Pick<Response, "ok" | "status">,
  result: unknown,
): void {
  if (
    !response.ok || !result || typeof result !== "object" ||
    (result as Record<string, unknown>).success === false ||
    (result as Record<string, unknown>).error
  ) {
    throw new Error(`ops_status_update_failed:${response.status}`);
  }
}
