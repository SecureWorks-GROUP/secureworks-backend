# One crew population for group work orders

Automatic membership, share readiness and the database's projection/freeze
read `public.group_work_order_crew(uuid[])`. The API pages every returned
person and refuses an unavailable or malformed read. It has no fallback
which could silently call a group ready with an incomplete crew.

The population contains distinct genuine allocations in the job's
organisation, excluding cancelled rows, observers, ghosts and office admin
watching allocations. A null legacy allocation status still counts. An
office manager who is genuinely allocated remains eligible to install.
Since `20261106160000`, anyone already paid by the hour on the job is not
crew either (see "Crew already paid by the hour" in
`group-work-orders-v1.md`). Since `20261106170000`, an office removal from
the job's live group beats that person's bookings (see "Office removal wins
over bookings").

Explicit members of an active group remain required after a role or
allocation changes, until the office removes them. Membership is a retained obligation; silently dropping
someone could lose a claim. Incorrect membership still needs the existing
office correction before finalisation. This does not add a watcher merely
because they have an allocation, remove members, change rates or create hours.

The migration replaces only the required-crew read inside
`group_work_order_write_split`. It refuses an unexpected predecessor rather
than overwriting another change. Existing locking, pool calculations, rate,
sign-off, double-pay and frozen-share rules remain. Projection and freeze
continue to use the same database writer. Frozen shares return their stored
snapshot before the new required-crew read.

Apply the migration before deploying the matching edge code. The edge schema
gate requires the helper. The function is read-only and callable by service
role only, never browser roles. The down migration restores the exact crew
read it replaced; publish the previous API before removing its RPC dependency.

Focused checks exercise the shared RPC, pagination, missing-read refusal,
watching admins, genuine office installers and retained membership. The
PostgreSQL contract checks real population rows, missing installer hours,
both split modes' sign-off refusal without frozen/share writes, exact
preservation of the rest of the installed writer, reapply, rollback and
deliberately broken predecessors/results. These use synthetic local records.

After publication, read the helper for the agreed control job and compare its
people with the current memberships and both call sites. Record frozen
timestamp and share count before/after; do not freeze, log hours, sign off or
write a share to obtain read-only evidence. A source preview before deployment
is not a deployed or live-screen claim.
