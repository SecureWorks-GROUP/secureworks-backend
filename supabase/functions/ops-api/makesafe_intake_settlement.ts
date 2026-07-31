// deno-lint-ignore-file no-explicit-any

export interface IntakeMint {
  id: string;
  draft_id: string;
  mint_role: string;
  case_id: string | null;
  source_post_ids: string[];
  job_id: string | null;
  state: string;
  evidence_attached_at: string | null;
  board_observed_at: string | null;
  notification_accepted_at: string | null;
}

export async function loadIntakeMints(
  client: any,
  draftId: string,
): Promise<IntakeMint[]> {
  const { data, error } = await client
    .from("makesafe_intake_job_mints")
    .select(
      "id,draft_id,mint_role,case_id,source_post_ids,job_id,state,evidence_attached_at,board_observed_at,notification_accepted_at",
    )
    .eq("draft_id", draftId)
    .order("mint_role", { ascending: true });
  if (error) {
    throw new Error(`intake mint read failed: ${error.message || error}`);
  }
  return (data || []) as IntakeMint[];
}

export async function reserveIntakeMint(
  client: any,
  input: {
    orgId: string;
    draftId: string;
    mintRole: string;
    caseId: string | null;
    sourcePostIds: readonly string[];
  },
): Promise<IntakeMint> {
  const { data, error } = await client.rpc("reserve_makesafe_intake_job_mint", {
    p_org_id: input.orgId,
    p_draft_id: input.draftId,
    p_mint_role: input.mintRole,
    p_case_id: input.caseId,
    p_source_post_ids: Array.from(new Set(input.sourcePostIds)).sort(),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    throw new Error(
      `intake mint reservation failed: ${error?.message || error || "missing row"}`,
    );
  }
  return row as IntakeMint;
}

export async function completeIntakeMint(
  client: any,
  mintId: string,
  jobId: string,
): Promise<IntakeMint> {
  const { data, error } = await client.rpc("complete_makesafe_intake_job_mint", {
    p_mint_id: mintId,
    p_job_id: jobId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    throw new Error(
      `intake mint completion failed: ${error?.message || error || "missing row"}`,
    );
  }
  return row as IntakeMint;
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

export async function settleApprovedIntakeDraft(
  client: any,
  input: {
    draftId: string;
    approvedJobId: string | null;
    attachments: readonly any[];
    extraction: Record<string, any>;
    notify: (input: {
      caseId: string;
      sourcePostIds: readonly string[];
      jobId: string;
      syntheticLivefireMarker?: string | null;
    }) => Promise<{
      accepted: boolean;
      reason: string;
      auditId: string | null;
    }>;
  },
): Promise<{
  jobIds: string[];
  notificationJobIds: string[];
  notificationsAccepted: number;
}> {
  const mints = await loadIntakeMints(client, input.draftId);
  const minted = mints.filter((mint) => mint.job_id);
  const evidenceJobIds = Array.from(new Set([
    ...minted.map((mint) => String(mint.job_id)),
    ...(input.approvedJobId ? [input.approvedJobId] : []),
  ]));
  await ensureIntakeWorkOrderEvidence(
    client,
    evidenceJobIds,
    input.attachments,
    input.extraction,
  );

  let notificationsAccepted = 0;
  const notificationJobIds: string[] = [];
  for (const mint of minted) {
    if (mint.state === "settled") continue;
    if (mint.notification_accepted_at) {
      notificationsAccepted++;
      continue;
    }
    if (!mint.case_id || !mint.source_post_ids.length) {
      throw new Error(`intake mint ${mint.id} lacks canonical source authority`);
    }
    const notification = await input.notify({
      caseId: mint.case_id,
      sourcePostIds: mint.source_post_ids,
      jobId: String(mint.job_id),
      syntheticLivefireMarker:
        input.extraction?.synthetic_livefire_marker || null,
    });
    if (notification.reason === "synthetic_livefire_suppressed") {
      const settledAt = new Date().toISOString();
      const { error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settled",
          evidence_attached_at: mint.evidence_attached_at || settledAt,
          board_observed_at: mint.board_observed_at || settledAt,
          last_error: null,
          updated_at: settledAt,
        })
        .eq("id", mint.id);
      if (error) {
        throw new Error(
          `synthetic intake settlement write failed: ${error.message || error}`,
        );
      }
      continue;
    }
    if (!notification.accepted) {
      const { error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settlement_failed",
          last_error: notification.reason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mint.id);
      if (error) {
        throw new Error(
          `intake settlement failure write failed: ${error.message || error}`,
        );
      }
      throw new Error(
        `post-board Hugo settlement failed for ${mint.job_id}: ${notification.reason}`,
      );
    }
    const settledAt = new Date().toISOString();
    const { data, error } = await client
      .from("makesafe_intake_job_mints")
      .update({
        state: "settled",
        evidence_attached_at: mint.evidence_attached_at || settledAt,
        board_observed_at: mint.board_observed_at || settledAt,
        notification_accepted_at: settledAt,
        last_error: null,
        updated_at: settledAt,
      })
      .eq("id", mint.id)
      .select("id")
      .maybeSingle();
    if (error || !data?.id) {
      throw new Error(
        `intake settlement completion write failed: ${
          error?.message || error || "row not updated"
        }`,
      );
    }
    notificationsAccepted++;
    notificationJobIds.push(String(mint.job_id));
  }
  return {
    jobIds: evidenceJobIds,
    notificationJobIds,
    notificationsAccepted,
  };
}
