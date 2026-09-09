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
