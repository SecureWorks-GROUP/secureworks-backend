import { type SesArtifact, sesSha256 } from "./ses_docket_envelope.ts";
import { evaluateSesDocsReadyGate } from "./ses_docs_ready.ts";
import type {
  SesPersistPayload,
  SesPrepareDependencies,
} from "./ses_prepare_docket_revision.ts";

export const SES_DOCKET_BUCKET = "makesafe-docket-artifacts";

interface SupabaseResult<T> {
  data: T | null;
  error: { message?: string; statusCode?: string; status?: number } | null;
}

export interface SesDocketPersistenceClient {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: {
          contentType: string;
          upsert: false;
        },
      ): Promise<SupabaseResult<unknown>>;
      download(path: string): Promise<SupabaseResult<Blob>>;
    };
  };
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<
          SupabaseResult<{
            content_hash: string;
            size_bytes: number;
          }>
        >;
      };
    };
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SupabaseResult<Record<string, unknown>>>;
}

export interface SesDocketPersistenceOptions {
  client: SesDocketPersistenceClient;
  org_id: string;
  created_by: string;
}

function safeArtifactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized || normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`unsafe docket artifact path: ${path}`);
  }
  return normalized;
}

function duplicateUpload(error: {
  message?: string;
  statusCode?: string;
  status?: number;
}): boolean {
  const status = Number(error.statusCode || error.status);
  return status === 409 ||
    String(error.message || "").toLowerCase().includes("already exists") ||
    String(error.message || "").toLowerCase().includes("duplicate");
}

async function assertExistingArtifactMatches(
  client: SesDocketPersistenceClient,
  storagePath: string,
  objectKey: string,
  artifact: SesArtifact,
): Promise<void> {
  const existing = await client.from("makesafe_docket_artifacts")
    .select("content_hash,size_bytes")
    .eq("object_key", objectKey)
    .maybeSingle();
  if (
    !existing.error && existing.data &&
    existing.data.content_hash === artifact.content_hash &&
    Number(existing.data.size_bytes) === artifact.size_bytes
  ) {
    return;
  }

  const downloaded = await client.storage.from(SES_DOCKET_BUCKET).download(
    storagePath,
  );
  if (!downloaded.error && downloaded.data) {
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    const contentHash = await sesSha256(
      Array.from(bytes),
      "SecureWorks:ses-docket-artifact-bytes:v1\n",
    );
    if (
      contentHash === artifact.content_hash &&
      bytes.byteLength === artifact.size_bytes
    ) {
      return;
    }
  }
  throw new Error(
    `input_hash_conflict: artifact object exists without matching bytes or committed metadata (${objectKey})`,
  );
}

export function createSesDocketPersistenceAdapter(
  options: SesDocketPersistenceOptions,
): NonNullable<SesPrepareDependencies["persist"]> {
  if (!options.org_id.trim()) throw new TypeError("org_id is required");
  if (!options.created_by.trim()) throw new TypeError("created_by is required");
  return async (payload: SesPersistPayload) => {
    const revision = payload.revision;
    const jobId = revision.envelope.spine.job_id;
    const revisionId = revision.docket_revision_id;
    const artifactRows: Array<Record<string, unknown>> = [];

    for (
      const artifact of payload.artifacts.slice().sort((left, right) =>
        left.path.localeCompare(right.path)
      )
    ) {
      const path = safeArtifactPath(artifact.path);
      const storagePath = `${jobId}/${revisionId}/${path}`;
      const objectKey = `${SES_DOCKET_BUCKET}/${storagePath}`;
      const uploaded = await options.client.storage.from(SES_DOCKET_BUCKET)
        .upload(storagePath, artifact.bytes, {
          contentType: artifact.media_type,
          upsert: false,
        });
      if (uploaded.error) {
        if (!duplicateUpload(uploaded.error)) {
          throw new Error(
            `docket artifact upload failed (${objectKey}): ${
              uploaded.error.message || "unknown storage error"
            }`,
          );
        }
        await assertExistingArtifactMatches(
          options.client,
          storagePath,
          objectKey,
          artifact,
        );
      }
      artifactRows.push({
        role: artifact.role,
        object_key: objectKey,
        media_type: artifact.media_type,
        content_hash: artifact.content_hash,
        size_bytes: artifact.size_bytes,
        metadata: artifact.metadata,
      });
    }

    const committed = await options.client.rpc(
      "commit_makesafe_docket_revision_v1",
      {
        p_revision: {
          id: revisionId,
          org_id: options.org_id,
          job_id: jobId,
          source_instruction_id: revision.envelope.spine.source_instruction_id,
          lineage_id: revision.envelope.spine.lineage_id,
          attendance_cycle_ids: revision.envelope.spine.attendance_cycle_ids,
          current_attendance_cycle_id:
            revision.envelope.spine.current_attendance_cycle_id,
          readiness_revision: revision.envelope.spine.readiness_revision,
          idempotency_key: payload.idempotency_key,
          assembler_version: payload.assembler_version,
          family_matrix_version: payload.family_matrix_version,
          input_content_hash: revision.input_content_hash,
          output_content_hash: revision.output_content_hash,
          state: revision.state,
          pre_xero_docs_ready: revision.envelope.pre_xero_docs_ready,
          local_invoice_proposal: revision.invoice_proposal,
          envelope: revision.envelope,
          blockers: revision.blockers,
          email_drafts: revision.email_drafts,
          review_spec: revision.review_spec,
          release_payload: revision.release_payload,
          accepted_at: payload.accepted_at,
          stage_durations_ms: payload.stage_durations_ms,
          created_by: options.created_by,
        },
        p_artifacts: artifactRows,
      },
    );
    if (committed.error || !committed.data) {
      throw new Error(
        `docket revision commit failed: ${
          committed.error?.message || "empty commit result"
        }`,
      );
    }
    const committedAt = String(committed.data.committed_at || "");
    if (!committedAt) {
      throw new Error("docket revision commit omitted committed_at");
    }
    const docsReady = evaluateSesDocsReadyGate(revision);
    if (docsReady.state === "needs_review") {
      const queued = await options.client.rpc(
        "record_ses_docket_review_state_v1",
        {
          p_event: {
            docket_revision_id: revisionId,
            event_kind: "prepared",
            expected_output_content_hash: revision.output_content_hash,
            actor_identity: options.created_by,
            reason: "The assembler completed the audit-grade family pack.",
          },
        },
      );
      if (queued.error || !queued.data) {
        throw new Error(
          `docket review queue commit failed: ${
            queued.error?.message || "empty review event result"
          }`,
        );
      }
    }
    return { committed_at: committedAt };
  };
}
