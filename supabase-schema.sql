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

create policy "aal2 required" on customers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create policy "aal2 required" on engineers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create policy "aal2 required" on jobs
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

create policy "aal2 required" on job_engineers
  for all
  using ( (select auth.jwt()->>'aal') = 'aal2' )
  with check ( (select auth.jwt()->>'aal') = 'aal2' );

-- ── Helpful indexes ────────────────────────────────────────────────
create index if not exists jobs_start_at_idx on jobs (start_at);
create index if not exists jobs_customer_id_idx on jobs (customer_id);
create index if not exists job_engineers_engineer_id_idx on job_engineers (engineer_id);
