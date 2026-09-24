-- Someone seeded the live T7 draft table before EM1 (production had it empty
-- on 24 Sep 2026). The deployed old monitor-inbox path would already be
-- polling that list, so EM1 must refuse rather than build on rows nobody read.
INSERT INTO public.monitored_mailboxes(email,scope_label) VALUES('finance@secureworkswa.com.au','finance');
-- And the email_capture_v2 flag row already there (production had none):
-- EM1 creates it off, so a row it did not create, on or off, is refused rather
-- than inherited.
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('email_capture_v2',true,'set by hand');
