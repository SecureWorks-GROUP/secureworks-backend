// deno-lint-ignore-file no-explicit-any
import { builderInstructionKeysForCard } from "./makesafe_builder_work_order_identity.ts";

const PAGE_SIZE = 1_000;
const ID_CHUNK_SIZE = 25;

export interface InstructionCardRow {
  job_id: string;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  jobs?: any;
}

export interface InstructionDocumentRow {
  job_id: string;
  type?: string | null;
  file_name?: string | null;
  storage_url?: string | null;
}

export interface ExistingInstructionCardMatch {
  jobId: string;
  jobNumber: string;
  status: string;
  instructionKeys: string[];
}

export class InstructionMintConflictError extends Error {
  constructor(
    public readonly candidateKeys: string[],
    public readonly matches: ExistingInstructionCardMatch[],
  ) {
    const cards = matches.map((match) => match.jobNumber).join(", ");
    super(
      `Instruction already has a card (${candidateKeys.join(", ")}): ${cards}`,
    );
    this.name = "InstructionMintConflictError";
  }
}

function jobOf(row: InstructionCardRow): any {
  return Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
}

export function matchExistingInstructionCards(
  candidateKeys: readonly string[],
  rows: readonly InstructionCardRow[],
  documents: readonly InstructionDocumentRow[],
): ExistingInstructionCardMatch[] {
  const wanted = new Set(candidateKeys);
  if (!wanted.size) return [];
  const namesByJob = new Map<string, string[]>();
  for (const document of documents) {
    if (String(document.type || "").toLowerCase() !== "work_order") continue;
    const name = String(document.file_name || document.storage_url || "");
    if (!name) continue;
    const names = namesByJob.get(String(document.job_id)) || [];
    names.push(name);
    namesByJob.set(String(document.job_id), names);
  }
  return rows.flatMap((row) => {
    const job = jobOf(row);
    const metadata = job?.metadata && typeof job.metadata === "object"
      ? job.metadata
      : {};
    const instructionKeys = builderInstructionKeysForCard({
      requestingCompanySlug: row.requesting_company_slug ||
        metadata.requesting_company?.slug || null,
      metadata,
      detailExternalRef: row.external_ref || null,
      attachmentNames: namesByJob.get(String(row.job_id)) || [],
    });
    if (!instructionKeys.some((key) => wanted.has(key))) return [];
    return [{
      jobId: String(row.job_id),
      jobNumber: String(job?.job_number || row.job_id),
      status: String(job?.status || ""),
      instructionKeys,
    }];
  });
}

export function refuseExistingInstructionCard(
  candidateKeys: readonly string[],
  rows: readonly InstructionCardRow[],
  documents: readonly InstructionDocumentRow[],
): void {
  const matches = matchExistingInstructionCards(candidateKeys, rows, documents);
  if (matches.length) {
    throw new InstructionMintConflictError([...candidateKeys], matches);
  }
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += ID_CHUNK_SIZE) {
    out.push(values.slice(index, index + ID_CHUNK_SIZE));
  }
  return out;
}

export async function assertInstructionCardMintAvailable(
  client: any,
  candidateKeys: readonly string[],
): Promise<void> {
  if (!candidateKeys.length) return;
  const rows: InstructionCardRow[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await client.from("makesafe_job_details")
      .select(
        "job_id,external_ref,requesting_company_slug,jobs(job_number,status,metadata)",
      )
      .order("job_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `instruction mint gate card read failed: ${error.message || error}`,
      );
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const jobIds = [...new Set(rows.map((row) => String(row.job_id)))];
  const documents: InstructionDocumentRow[] = [];
  for (const ids of chunks(jobIds)) {
    for (let from = 0;; from += PAGE_SIZE) {
      const { data, error } = await client.from("job_documents")
        .select("job_id,type,file_name,storage_url")
        .in("job_id", ids)
        .eq("type", "work_order")
        .order("job_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        throw new Error(
          `instruction mint gate document read failed: ${
            error.message || error
          }`,
        );
      }
      const page = data || [];
      documents.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  refuseExistingInstructionCard(candidateKeys, rows, documents);
}

export async function reserveInstructionCardMint(
  client: any,
  input: { orgId: string; draftId: string; candidateKeys: readonly string[] },
): Promise<void> {
  if (!input.candidateKeys.length) return;
  const { error } = await client.rpc(
    "reserve_makesafe_instruction_key_mint",
    {
      p_org_id: input.orgId,
      p_draft_id: input.draftId,
      p_instruction_keys: [...new Set(input.candidateKeys)].sort(),
    },
  );
  if (error) {
    throw new InstructionMintConflictError(input.candidateKeys, []);
  }
}

export async function releaseInstructionCardMint(
  client: any,
  input: { orgId: string; draftId: string },
): Promise<void> {
  const { error } = await client.rpc(
    "release_makesafe_instruction_key_mint",
    { p_org_id: input.orgId, p_draft_id: input.draftId },
  );
  if (error) throw error;
}
