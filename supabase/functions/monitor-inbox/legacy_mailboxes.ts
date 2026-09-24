// The old monitor-inbox path's sources, pinned (email.md finding 15, review
// M14; slice EM1).
//
// The old path polls exactly these five user mailboxes and two groups. It used
// to switch to the monitored_mailboxes table whenever that table had enabled
// rows; EM1 seeds that table for the new poller (EM2), whose list includes
// khairo@ and groups the old path cannot poll as users. So the old
// path no longer reads the table at all: it polls this list until the old path
// is deleted (EM-C). The new poller reads monitored_mailboxes only while flag
// email_capture_v2 is on.
//
// khairo@ is deliberately absent: the old path never read it, and it is
// captured by the new poller only.

export const LEGACY_USER_MAILBOXES: readonly string[] = Object.freeze([
  "marnin@secureworkswa.com.au",
  "jan@secureworkswa.com.au",
  "nithin@secureworkswa.com.au", // Sales (patios)
  "shaun@secureworkswa.com.au", // Ops manager
  "admin@secureworkswa.com.au", // Shared admin inbox
]);

/** M365 Groups (receive-only). Never call /users/{mail} for these: that
 * returns ErrorInvalidUser. */
export const LEGACY_GROUP_MAILBOXES: readonly string[] = Object.freeze([
  "patios@secureworkswa.com.au",
  "fencing@secureworkswa.com.au",
]);

/** What one old-path run polls. Pure: no table, flag or environment read. */
export function legacyPollPlan(): {
  users: readonly string[];
  groups: readonly string[];
  mailbox_source: "hard_coded";
} {
  return {
    users: LEGACY_USER_MAILBOXES,
    groups: LEGACY_GROUP_MAILBOXES,
    mailbox_source: "hard_coded",
  };
}
