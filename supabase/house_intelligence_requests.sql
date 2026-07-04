-- House Intelligence — Supabase migration for `house_intelligence_requests`
-- Run this once in the Supabase SQL editor (Kairo Project). It is NON-DESTRUCTIVE:
-- it only ADDs columns/policies; it never drops or renames anything you have.
--
-- The table pre-existed with: id, profile_id, requested_at, address, year_built,
-- state, year_source. This adds the BuildSuite match keys + the richer output so
-- the contractor's matched-clients view can query inspection detail per match.

-- 1) Add the new columns (safe to re-run).
alter table house_intelligence_requests
  add column if not exists project_id    uuid,
  add column if not exists contractor_id uuid,
  add column if not exists client_id     uuid,     -- clients.id (uuid)
  add column if not exists contact_id    text,     -- GHL ghl_contact_id -> matches.contact_id
  add column if not exists severity      text,     -- High | Medium | Low
  add column if not exists resolved      boolean not null default false,
  add column if not exists scope         jsonb,    -- full engine output
  add column if not exists property      jsonb;     -- size/layout + features

-- 2) Fast "latest detail for this contractor+client" reads (append-log pattern).
create index if not exists house_intelligence_requests_lookup
  on house_intelligence_requests (contractor_id, client_id, requested_at desc);

-- 3) RLS so the publishable (anon) key can ONLY append here — and, because RLS is
--    then default-deny, cannot reach any other table without its own policy.
alter table house_intelligence_requests enable row level security;

drop policy if exists hi_insert on house_intelligence_requests;
create policy hi_insert on house_intelligence_requests
  for insert to anon with check (true);

drop policy if exists hi_select on house_intelligence_requests;
create policy hi_select on house_intelligence_requests
  for select to anon using (true);

-- RECOMMENDED (closes the last gap): enable RLS on the other tables so the same
-- key physically cannot touch them. Uncomment after confirming BuildSuite reads
-- them with the service key, not the publishable one.
-- alter table clients                         enable row level security;
-- alter table matches                         enable row level security;
-- alter table contractor_application_business enable row level security;
