type MarkClient = {
  rpc(name: string, args: { p_job_id: string; p_source: string }): PromiseLike<{
    error: { code?: string } | null;
  }>;
};

/** One bounded, sequential flush for a sync action. Trigger-covered writes do not add here. */
export class JobMarks {
  private jobs = new Map<string, string>();

  add(jobId: string | null | undefined, source: string): void {
    if (jobId && !this.jobs.has(jobId)) this.jobs.set(jobId, source);
  }

  async flush(
    sb: MarkClient,
  ): Promise<{ marked: number; skipped: string | null }> {
    let marked = 0;
    let attempted = 0;
    for (const [p_job_id, p_source] of this.jobs) {
      if (attempted++ === 500) return { marked, skipped: "over_500" };
      try {
        const { error } = await sb.rpc("job_mark_changed", {
          p_job_id,
          p_source,
        });
        if (error?.code === "PGRST202") {
          return { marked, skipped: "no_function" };
        }
        if (error) console.error("[xero-sync] Job mark failed:", error.code);
        else marked++;
      } catch {
        console.error("[xero-sync] Job mark request failed");
      }
    }
    return { marked, skipped: null };
  }
}
