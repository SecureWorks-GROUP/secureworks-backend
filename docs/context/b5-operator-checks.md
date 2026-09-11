# B5 operator checks (prepared only; not executed)

1. Confirm Microsoft app Mail.Read and group-conversation read access; test each named user/group with read-only Graph requests after reconnecting credentials.
2. Provision or confirm khairo@secureworkswa.com.au, then enable both Khairo stream rows. Do not mark it provisioned merely because the migration registers its name.
3. Establish whether orders@secureworkswa.com.au has a Microsoft user mailbox or Group. Existing Resend tagged replies are handled independently by receive-po-email; a sender address is not a mailbox. Correct only the orders stream configuration after provider identity is known.
4. Apply B1, B2, then B5 through the approved migration route before deploying monitor-inbox. No new environment variable is required; the endpoint uses existing MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and service credentials. No values belong in this document.
5. Verify private bucket visibility, per-stream response coverage, actual group attachment expansion and initial metadata-scan completion. No source can be called complete while continuing, unavailable, deferred or failed.

No live commands, cron activation, permission grants, mail sends or credential changes are authorized by this checklist.
