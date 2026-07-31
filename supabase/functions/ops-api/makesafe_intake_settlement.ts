// deno-lint-ignore-file no-explicit-any

export function intakeMintedJobIds(
  extraction: Record<string, any>,
  approvedJobId: string | null,
): string[] {
  if (Array.isArray(extraction.intake_minted_job_ids)) {
    return Array.from(
      new Set(
        extraction.intake_minted_job_ids
          .map((value: any) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
  }
  if (extraction.deterministic_intake === true && approvedJobId) {
    return [approvedJobId];
  }
  return [];
}

export async function ensureIntakeWorkOrderEvidence(
  client: any,
  jobIds: readonly string[],
  attachments: readonly any[],
  extraction: Record<string, any>,
): Promise<void> {
  const uniqueJobIds = Array.from(
    new Set(
      jobIds.map((value) => String(value || "").trim()).filter(Boolean),
    ),
  );
  if (!uniqueJobIds.length || !attachments.length) {
    throw new Error(
      "work-order evidence settlement requires jobs and attachments",
    );
  }
  const { data: existing, error: existingError } = await client
    .from("job_documents")
    .select("job_id,storage_url,pdf_url")
    .in("job_id", uniqueJobIds)
    .eq("type", "work_order");
  if (existingError) {
    throw new Error(
      `work-order evidence read failed: ${
        existingError.message || existingError
      }`,
    );
  }
  const existingKeys = new Set(
    (existing || []).flatMap((row: any) => {
      const urls = [row.storage_url, row.pdf_url].filter(Boolean);
      return urls.map((url: string) => `${row.job_id}:${url}`);
    }),
  );
  for (const jobId of uniqueJobIds) {
    for (const attachment of attachments) {
      const storageUrl = attachment.storage_url || attachment.pdf_url;
      const pdfUrl = attachment.pdf_url || attachment.storage_url;
      if (
        existingKeys.has(`${jobId}:${storageUrl}`) ||
        existingKeys.has(`${jobId}:${pdfUrl}`)
      ) continue;
      const { error } = await client.from("job_documents").insert({
        job_id: jobId,
        type: "work_order",
        file_name: attachment.file_name || attachment.name || "work-order.pdf",
        storage_url: storageUrl,
        pdf_url: pdfUrl,
        ...(extraction?.synthetic_livefire_marker
          ? {
            data_snapshot_json: {
              synthetic_livefire_marker: extraction.synthetic_livefire_marker,
            },
          }
          : {}),
        visible_to_trades: true,
      });
      if (error) {
        throw new Error(
          `work-order evidence attach failed: ${error.message || error}`,
        );
      }
      existingKeys.add(`${jobId}:${storageUrl}`);
      existingKeys.add(`${jobId}:${pdfUrl}`);
    }
  }
}
