-- Disposable database only. Core referenced production column types.
CREATE TABLE public.jobs(id uuid PRIMARY KEY, org_id uuid NOT NULL, status text NOT NULL, type text NOT NULL, job_number text NOT NULL UNIQUE);
CREATE TABLE public.business_events(id uuid PRIMARY KEY,job_id uuid REFERENCES public.jobs(id));
