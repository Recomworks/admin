-- Recomworks Admin System — Supabase database schema
-- Run this once in your Supabase project: SQL Editor -> New query -> paste all -> Run

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ── Customers ──────────────────────────────────────────────────────
create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  company_name  text not null,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Engineers / contractors ───────────────────────────────────────
create table if not exists engineers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text,
  phone         text,
  skills        text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Jobs / bookings ────────────────────────────────────────────────
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customers(id) on delete set null,
  service_type  text,
  site_address  text,
  start_at      timestamptz not null,
  end_at        timestamptz,
  status        text not null default 'unassigned'
                  check (status in ('unassigned','assigned','confirmed','completed','cancelled')),
  po_reference  text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Job <-> engineer assignment (many-to-many) ────────────────────
create table if not exists job_engineers (
  job_id        uuid references jobs(id) on delete cascade,
  engineer_id   uuid references engineers(id) on delete cascade,
  primary key (job_id, engineer_id)
);

-- ── Row Level Security ─────────────────────────────────────────────
-- Every table requires a fully-authenticated session at AAL2, i.e. the
-- user has signed in with a password AND completed a TOTP 2FA challenge.
-- A password-only (AAL1) session cannot read or write any data here.

alter table customers      enable row level security;
alter table engineers      enable row level security;
alter table jobs           enable row level security;
alter table job_engineers  enable row level security;

drop policy if exists "aal2 required" on customers;
create policy "aal2 required" on customers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

drop policy if exists "aal2 required" on engineers;
create policy "aal2 required" on engineers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

drop policy if exists "aal2 required" on jobs;
create policy "aal2 required" on jobs
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

drop policy if exists "aal2 required" on job_engineers;
create policy "aal2 required" on job_engineers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

-- ── Helpful indexes ────────────────────────────────────────────────
create index if not exists jobs_start_at_idx on jobs (start_at);
create index if not exists jobs_customer_id_idx on jobs (customer_id);
create index if not exists job_engineers_engineer_id_idx on job_engineers (engineer_id);


-- ═══════════════════════════════════════════════════════════════════
-- Update 2 — sub-customers, logos, structured addresses, contractor
-- rate/UTR/invoices. Safe to run again — every statement is idempotent
-- (ALTER ... ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════

-- ── Customers: sub-customer/owner link, logo, contact position,
--    structured address ─────────────────────────────────────────────
alter table customers add column if not exists parent_customer_id uuid references customers(id) on delete set null;
alter table customers add column if not exists logo_path      text;  -- path inside the 'logos' storage bucket
alter table customers add column if not exists contact_position text; -- e.g. "Director"
alter table customers add column if not exists address_line1  text;
alter table customers add column if not exists address_line2  text;
alter table customers add column if not exists town           text;
alter table customers add column if not exists county         text;
alter table customers add column if not exists postcode       text;
alter table customers add column if not exists country        text;

create index if not exists customers_parent_customer_id_idx on customers (parent_customer_id);

-- ── Engineers / contractors: structured address, UTR, rate ─────────
alter table engineers add column if not exists address_line1  text;
alter table engineers add column if not exists address_line2  text;
alter table engineers add column if not exists town           text;
alter table engineers add column if not exists county         text;
alter table engineers add column if not exists postcode       text;
alter table engineers add column if not exists country        text;
alter table engineers add column if not exists utr_number     text;  -- UK Unique Taxpayer Reference
alter table engineers add column if not exists rate           numeric(10,2);
alter table engineers add column if not exists rate_type      text default 'day';

do $$ begin
  alter table engineers add constraint engineers_rate_type_check check (rate_type in ('day','hour','fixed'));
exception when duplicate_object then null;
end $$;

-- ── Jobs: structured site address (site_address itself is kept in
--    sync automatically by the app as a plain-text summary, so
--    anything already reading job.site_address — the jobs table, the
--    "email contractor" button, the Outlook feed — keeps working) ──
alter table jobs add column if not exists site_address_line1 text;
alter table jobs add column if not exists site_address_line2 text;
alter table jobs add column if not exists site_town          text;
alter table jobs add column if not exists site_county        text;
alter table jobs add column if not exists site_postcode      text;
alter table jobs add column if not exists site_country        text;

-- ── Contractor invoices (files themselves live in Supabase Storage;
--    this table just indexes them) ──────────────────────────────────
create table if not exists engineer_invoices (
  id            uuid primary key default gen_random_uuid(),
  engineer_id   uuid not null references engineers(id) on delete cascade,
  file_path     text not null,   -- path inside the 'contractor-invoices' storage bucket
  file_name     text,            -- original filename, for display
  amount        numeric(10,2),
  notes         text,
  uploaded_at   timestamptz not null default now()
);

alter table engineer_invoices enable row level security;

drop policy if exists "aal2 required" on engineer_invoices;
create policy "aal2 required" on engineer_invoices
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create index if not exists engineer_invoices_engineer_id_idx on engineer_invoices (engineer_id);

-- ── Storage buckets for logos and contractor invoices ───────────────
-- Both are PRIVATE (public = false): files are only ever reached via a
-- short-lived signed URL generated by the app for a signed-in,
-- 2FA-verified session — never a permanent public link.
insert into storage.buckets (id, name, public)
  values ('logos', 'logos', false)
  on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
  values ('contractor-invoices', 'contractor-invoices', false)
  on conflict (id) do nothing;

drop policy if exists "aal2 required logos" on storage.objects;
create policy "aal2 required logos" on storage.objects
  for all
  using ( bucket_id = 'logos' and (select auth.jwt()->>'aal') = 'aal2' )
  with check ( bucket_id = 'logos' and (select auth.jwt()->>'aal') = 'aal2' );

drop policy if exists "aal2 required invoices" on storage.objects;
create policy "aal2 required invoices" on storage.objects
  for all
  using ( bucket_id = 'contractor-invoices' and (select auth.jwt()->>'aal') = 'aal2' )
  with check ( bucket_id = 'contractor-invoices' and (select auth.jwt()->>'aal') = 'aal2' );


-- ═══════════════════════════════════════════════════════════════════
-- Update 3 — charge rates (what you bill customers), job profit
-- tracking, and per-engineer payment status. Safe to run again.
-- ═══════════════════════════════════════════════════════════════════

-- ── Charge rates: your own admin-managed price list, e.g.
--    "Senior Engineer" £200/day, "Standard Engineer" £165/day ────────
create table if not exists charge_rates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  amount        numeric(10,2) not null,
  rate_type     text not null default 'day',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

do $$ begin
  alter table charge_rates add constraint charge_rates_rate_type_check check (rate_type in ('day','hour','fixed'));
exception when duplicate_object then null;
end $$;

alter table charge_rates enable row level security;

drop policy if exists "aal2 required" on charge_rates;
create policy "aal2 required" on charge_rates
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

-- ── Jobs: what this specific job charges the customer. The rate is
--    picked from charge_rates, but the name/amount are copied onto the
--    job itself so a later change to (or deletion of) a rate card entry
--    never rewrites the price of a job already booked. ────────────────
alter table jobs add column if not exists charge_rate_id   uuid references charge_rates(id) on delete set null;
alter table jobs add column if not exists charge_amount    numeric(10,2);
alter table jobs add column if not exists charge_rate_name text;

-- ── job_engineers: what this engineer costs on this specific job (also
--    a snapshot, same reasoning as above — defaults to their profile
--    rate when assigned, but can be overridden per job), plus payment
--    tracking so you can see, per job per engineer, whether their
--    invoice has come in and whether they've been paid. ───────────────
alter table job_engineers add column if not exists cost_amount         numeric(10,2);
alter table job_engineers add column if not exists payment_status      text not null default 'unpaid';
alter table job_engineers add column if not exists invoice_received_at timestamptz;
alter table job_engineers add column if not exists paid_at             timestamptz;

do $$ begin
  alter table job_engineers add constraint job_engineers_payment_status_check check (payment_status in ('unpaid','invoice_received','paid'));
exception when duplicate_object then null;
end $$;


-- ═══════════════════════════════════════════════════════════════════
-- Update 4 — client name/description/on-site contact/site foreman on
-- jobs, a second ("moving to") site address, and booking lines: a job
-- can now have any number of date + time + rate + engineer rows
-- instead of one single date/rate/engineer per job. Safe to run again.
-- ═══════════════════════════════════════════════════════════════════

-- ── Jobs: client name, description, on-site contact, site foreman,
--    and an optional second address for jobs that are a move (not just
--    a decommission) ────────────────────────────────────────────────
alter table jobs add column if not exists client_name          text;
alter table jobs add column if not exists description          text;
alter table jobs add column if not exists onsite_contact_name  text;
alter table jobs add column if not exists onsite_contact_phone text;
alter table jobs add column if not exists onsite_contact_email text;
alter table jobs add column if not exists site_foreman_name    text;
alter table jobs add column if not exists site_foreman_phone   text;
alter table jobs add column if not exists has_move_to_address  boolean not null default false;
alter table jobs add column if not exists move_to_address_line1 text;
alter table jobs add column if not exists move_to_address_line2 text;
alter table jobs add column if not exists move_to_town          text;
alter table jobs add column if not exists move_to_county        text;
alter table jobs add column if not exists move_to_postcode      text;
alter table jobs add column if not exists move_to_country       text;

-- ── Booking lines: one row per date + time-slot + rate + (optional)
--    assigned engineer on a job, e.g. "Mon 7 Sep, 9am-5:30pm, 1x Senior
--    Engineer at £200" and "Mon 7 Sep, 9am-5:30pm, 1x Standard Engineer
--    at £165" are two separate rows on the same job. Rate name/amount
--    and engineer cost are snapshotted at the time the line is saved,
--    same reasoning as jobs.charge_amount / job_engineers.cost_amount —
--    editing or deleting a rate card entry or engineer later never
--    rewrites the price of a booking line already saved. Each line
--    tracks its own payment status so part of a job can be paid out
--    before the rest. ──────────────────────────────────────────────
create table if not exists job_booking_lines (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references jobs(id) on delete cascade,
  booking_date          date not null,
  start_time            time,
  end_time              time,
  charge_rate_id        uuid references charge_rates(id) on delete set null,
  charge_rate_name      text,
  charge_amount         numeric(10,2),
  engineer_id           uuid references engineers(id) on delete set null,
  cost_amount           numeric(10,2),
  payment_status        text not null default 'unpaid',
  invoice_received_at   timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

do $$ begin
  alter table job_booking_lines add constraint job_booking_lines_payment_status_check check (payment_status in ('unpaid','invoice_received','paid'));
exception when duplicate_object then null;
end $$;

alter table job_booking_lines enable row level security;

drop policy if exists "aal2 required" on job_booking_lines;
create policy "aal2 required" on job_booking_lines
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create index if not exists job_booking_lines_job_id_idx on job_booking_lines (job_id);
create index if not exists job_booking_lines_booking_date_idx on job_booking_lines (booking_date);
create index if not exists job_booking_lines_engineer_id_idx on job_booking_lines (engineer_id);


-- ═══════════════════════════════════════════════════════════════════
-- Update 5 — link one uploaded contractor invoice to any number of
-- booking lines (a contractor's single invoice often covers several
-- jobs), so Payments has a real audit trail: the date an invoice was
-- received and the actual file, not just a status flag. Safe to run
-- again.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists invoice_booking_lines (
  invoice_id      uuid not null references engineer_invoices(id) on delete cascade,
  booking_line_id uuid not null references job_booking_lines(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (invoice_id, booking_line_id)
);

alter table invoice_booking_lines enable row level security;

drop policy if exists "aal2 required" on invoice_booking_lines;
create policy "aal2 required" on invoice_booking_lines
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create index if not exists invoice_booking_lines_invoice_id_idx on invoice_booking_lines (invoice_id);
create index if not exists invoice_booking_lines_booking_line_id_idx on invoice_booking_lines (booking_line_id);


-- ═══════════════════════════════════════════════════════════════════
-- Update 6 — jobs link to a real client record (not just free-text
-- client_name), a client can store its own "site being decommissioned"
-- and "moving to" addresses (reused across every job booked for that
-- client instead of being retyped each time), and booking lines record
-- which phase of the job they are — the decommission at the old site,
-- or the recommission/setup at the new one — so a job can have e.g. a
-- decommission line on the morning of day 1 and a recommission line
-- that same afternoon, or the next day, each showing correctly on the
-- calendar. Safe to run again.
-- ═══════════════════════════════════════════════════════════════════

-- ── Jobs: a real link to the client (a customers row with
--    parent_customer_id set) instead of only a free-text name. The old
--    client_name column is kept — it's now just a snapshot of the
--    client's name at the time the job was saved (same pattern as
--    charge_rate_name on booking lines), so a job's history reads
--    correctly even if the client is later renamed, and legacy jobs
--    saved before this update keep displaying via that same text. ────
alter table jobs add column if not exists client_id uuid references customers(id) on delete set null;
create index if not exists jobs_client_id_idx on jobs (client_id);

-- ── Customers/clients: a "site being decommissioned" and "moving to"
--    address, separate from the ordinary contact/registered address
--    added in Update 2 above. ───────────────────────────────────────
alter table customers add column if not exists decomm_address_line1   text;
alter table customers add column if not exists decomm_address_line2   text;
alter table customers add column if not exists decomm_town            text;
alter table customers add column if not exists decomm_county          text;
alter table customers add column if not exists decomm_postcode        text;
alter table customers add column if not exists decomm_country         text;
alter table customers add column if not exists new_site_address_line1 text;
alter table customers add column if not exists new_site_address_line2 text;
alter table customers add column if not exists new_site_town          text;
alter table customers add column if not exists new_site_county        text;
alter table customers add column if not exists new_site_postcode      text;
alter table customers add column if not exists new_site_country       text;

-- ── Booking lines: decommission vs. recommission/new-site phase ────
alter table job_booking_lines add column if not exists phase text not null default 'decommission';

do $$ begin
  alter table job_booking_lines add constraint job_booking_lines_phase_check check (phase in ('decommission','recommission'));
exception when duplicate_object then null;
end $$;
