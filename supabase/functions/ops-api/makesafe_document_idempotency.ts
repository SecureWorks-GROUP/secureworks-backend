// deno-lint-ignore-file no-explicit-any

export const MAKESAFE_ATTACH_KEY_CONSTRAINT =
  "ux_job_documents_makesafe_attach_key";

export interface ActiveMakesafeDocumentKey {
  jobId: string;
  type: string;
  fileName: string;
}

export function isMakesafeAttachKeyConflict(error: any): boolean {
  if (error?.code !== "23505") return false;
  return [error.message, error.details, error.hint].some((value) =>
    String(value || "").includes(MAKESAFE_ATTACH_KEY_CONSTRAINT)
  );
}

export async function insertOrReadActiveMakesafeDocument(
  client: any,
  input: {
    key: ActiveMakesafeDocumentKey;
    row: Record<string, unknown>;
    select: string;
  },
): Promise<{ row: any; inserted: boolean }> {
  const inserted = await client.from("job_documents")
    .insert(input.row)
    .select(input.select)
    .single();
  if (!inserted.error) {
    if (!inserted.data?.id) {
      throw new Error("job document insert returned no row");
    }
    return { row: inserted.data, inserted: true };
  }
  if (!isMakesafeAttachKeyConflict(inserted.error)) {
    throw inserted.error;
  }

  const winner = await client.from("job_documents")
    .select(input.select)
    .eq("job_id", input.key.jobId)
    .eq("type", input.key.type)
    .eq("file_name", input.key.fileName)
    .is("superseded_at", null)
    .limit(1);
  if (winner.error) throw winner.error;
  if (!winner.data?.[0]?.id) throw inserted.error;
  return { row: winner.data[0], inserted: false };
}
