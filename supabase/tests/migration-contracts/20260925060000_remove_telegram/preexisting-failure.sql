-- A telegram authority row written after the production read: the count is no
-- longer the pinned 13, so the migration must refuse rather than delete it.
INSERT INTO public.authority_levels (action, channel) VALUES ('late_write', 'telegram');
