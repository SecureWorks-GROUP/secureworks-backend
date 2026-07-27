// This source placeholder is replaced immediately before ops-api is bundled.
// It must never contain remembered deploy values: an unstamped checkout reports
// metadata_status=unavailable rather than impersonating an older deployment.
export const OPS_API_DEPLOY_METADATA: {
  commit_sha: string | null;
  deployed_at: string | null;
} = {
  commit_sha: null,
  deployed_at: null,
};
