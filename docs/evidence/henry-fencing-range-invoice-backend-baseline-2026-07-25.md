# Henry fencing backend validation baseline

Date: 2026-07-25 (Australia/Perth)

## Clean-base counterfactual

- Base: exact local `origin/main` commit
  `6b75dbb2cdd382622507f487ffff196e56951462`.
- Method: materialised `git archive origin/main` into a temporary ignored
  `.omx/` snapshot inside the isolated task worktree.
- Command, run unchanged in both the clean snapshot and the feature worktree:

```bash
/Users/marninstobbe/.deno/bin/deno test --no-check \
  --allow-env --allow-net=127.0.0.1 --allow-read \
  supabase/functions/ops-api/makesafe_intake_late_pdf_test.ts
```

Both runs exited `1` with `18 passed | 1 failed`. After normalising only the
temporary absolute path, ANSI colour and elapsed milliseconds, the complete
failing assertion blocks were byte-identical:

```text
orchestration: two-email seq UPDATEs the existing draft in place (no INSERT), no auto-file when disabled
AssertionError: Values are not equal.

Actual:
{
  job_id: null,
  reason: "auto_file_error:Draft not found",
}

Expected:
null

makesafe_intake_late_pdf_test.ts:360:5
```

## Scope conclusion

The MakeSafe failure exists unchanged on `origin/main`; it is not caused by the
Henry fencing range, planning, allocation or work-order invoice changes. This
branch does not edit the failing test or the unrelated MakeSafe implementation.
The temporary snapshot and its logs were removed after this comparison.
