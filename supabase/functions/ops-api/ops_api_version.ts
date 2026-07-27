import { OPS_API_DEPLOY_METADATA } from "./deploy_metadata.ts";

const OPS_API_SOURCE_REPO = "secureworks-site";
const OPS_API_BUILD_LABEL = "ops-apiV1-trusted-18MAY-plus-secure-sale";

export interface OpsApiDeployMetadata {
  commit_sha: string | null;
  deployed_at: string | null;
}

export function buildOpsApiVersion(
  metadata: OpsApiDeployMetadata = OPS_API_DEPLOY_METADATA,
  _runtimeEnv: Record<string, string | undefined> = {},
) {
  const bundled = !!metadata.commit_sha && !!metadata.deployed_at;
  return {
    ok: true,
    source_repo: OPS_API_SOURCE_REPO,
    build_label: OPS_API_BUILD_LABEL,
    commit_sha: bundled ? metadata.commit_sha : null,
    deployed_at: bundled ? metadata.deployed_at : null,
    metadata_status: bundled ? "bundled" : "unavailable",
    canonical_note:
      "Production deploy identity is bundled into ops-api at deploy time; mutable runtime secrets are never version truth.",
  };
}
