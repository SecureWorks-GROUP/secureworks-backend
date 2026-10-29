# Owner's read-only Trade preview

The owner's Trade menu has **View as trade** for checking live jobs and pay without borrowing a worker's credentials. It retains the owner's real Supabase session and audit actor. No worker JWT is created.

`trade_preview_context` accepts only the verified owner's JWT email, with an admin/owner database role. Its selector lists non-office profiles in that same organisation. An optional `user_id` returns only the selected worker's app profile, with private trade details limited to the GST preference.

Preview reads carry `preview_trade_user_id` in the query. Before normal dispatch, the server checks the real owner, the reviewed action/method allow-list, and a same-organisation non-office target. Existing authorization receives that worker's role and managed scopes. `authTrade` independently resolves the same worker for the Trade handlers. Logs retain the real owner and name the preview subject. Unknown actions and all mutations are refused, including writes disguised as GETs. The group-share POST is a read and is explicitly allowed.

The app reloads when entering, switching or exiting preview so asynchronous state cannot cross workers. A persistent banner identifies the worker and read-only state. Jobs, Calendar and Pay use live requests; browser-local job/draft snapshots, queued work, autosaves and reconnect replay are bypassed. Write controls are disabled. Profile settings, Board, comms and quote extraction are outside this first preview slice. Exit returns to the owner's own view.

Checks: `trade_owner_preview_test.ts` exercises owner identity, default-deny actions, target tenant/role, profile minimisation and refusal before queries. `tests/e2e/trade-owner-preview.spec.js` in secureworks-ux drives the real Trade page using controlled API/auth fixtures, including switching two workers, own-share display, disabled submission, reconnect queue preservation and returning to the owner. Production proof must separately identify the live owner session and chosen worker; preview is not evidence of an employee login or a submitted invoice.

Mixed office/trade accounts such as Henry remain on their stored role. The owner may preview an ops_manager with an hourly or per_metre invoice profile; admin/owner targets remain excluded. Preview is still read only. `my_group_work_orders` is a permitted GET read.
