-- Mark all draft jobs as legacy — these are GHL imports and abandoned scopes
-- Real jobs have progressed past draft to quoted/accepted/etc
UPDATE jobs SET legacy = true WHERE status = 'draft';
