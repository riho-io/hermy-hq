-- Isiklikud arved (/arved). Rakenda enne koodi deploy'd.
-- Supabase projekt ekjvvzlewdafnyiblrbu, migratsiooni nimi: hermyhq_bills. Turvaline uuesti käivitada.
-- Skeem hermyhq ei ole PostgREST-is avatud; RLS sees; õigused ainult rollile hermyhq.

create table if not exists hermyhq.bill_group (
  id         text primary key,
  name       text not null check (char_length(name) between 1 and 80),
  address    text check (char_length(address) <= 200),
  keywords   text[] not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists hermyhq.bill (
  id                text primary key,
  group_id          text references hermyhq.bill_group(id) on delete set null,
  source            text not null check (source in ('email','manual')),
  status            text not null check (status in ('new','review','paid','ignored')),
  supplier          text check (char_length(supplier) <= 120),
  amount_cents      integer check (amount_cents between 0 and 100000000),
  currency          text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  due_date          date,
  reference         text check (char_length(reference) <= 60),
  iban              text check (char_length(iban) <= 40),
  contract_no       text check (char_length(contract_no) <= 60),
  service_address   text check (char_length(service_address) <= 200),
  pay_url           text check (char_length(pay_url) <= 500),
  notes             text check (char_length(notes) <= 1000),
  email_id          text unique,
  from_addr         text check (char_length(from_addr) <= 200),
  subject           text check (char_length(subject) <= 300),
  ignore_reason     text check (char_length(ignore_reason) <= 200),
  paid_at           timestamptz,
  remind3_sent_at   timestamptz,
  remind_due_sent_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists bill_status_due_idx on hermyhq.bill (status, due_date);
create index if not exists bill_group_idx on hermyhq.bill (group_id);

create table if not exists hermyhq.bill_file (
  bill_id      text primary key references hermyhq.bill(id) on delete cascade,
  filename     text not null check (char_length(filename) <= 200),
  content_type text not null check (content_type = 'application/pdf'),
  size         integer not null check (size between 1 and 5242880),
  data         bytea not null
);

alter table hermyhq.bill_group enable row level security;
alter table hermyhq.bill       enable row level security;
alter table hermyhq.bill_file  enable row level security;

revoke all on hermyhq.bill_group, hermyhq.bill, hermyhq.bill_file from public, anon, authenticated;
grant select, insert, update, delete on hermyhq.bill_group, hermyhq.bill, hermyhq.bill_file to hermyhq;

do $$
declare t text;
begin
  foreach t in array array['bill_group','bill','bill_file'] loop
    execute format('drop policy if exists %I on hermyhq.%I', t || '_app_select', t);
    execute format('drop policy if exists %I on hermyhq.%I', t || '_app_insert', t);
    execute format('drop policy if exists %I on hermyhq.%I', t || '_app_update', t);
    execute format('drop policy if exists %I on hermyhq.%I', t || '_app_delete', t);
    execute format('create policy %I on hermyhq.%I for select to hermyhq using (true)', t || '_app_select', t);
    execute format('create policy %I on hermyhq.%I for insert to hermyhq with check (true)', t || '_app_insert', t);
    execute format('create policy %I on hermyhq.%I for update to hermyhq using (true) with check (true)', t || '_app_update', t);
    execute format('create policy %I on hermyhq.%I for delete to hermyhq using (true)', t || '_app_delete', t);
  end loop;
end $$;

-- Kontroll (käsitsi pärast rakendamist):
-- select relname, relrowsecurity from pg_class where relname in ('bill_group','bill','bill_file');   -- kõik true
-- select grantee, privilege_type from information_schema.role_table_grants where table_name = 'bill'; -- ainult hermyhq
-- get_advisors(type: security): ükski uus leid ei tohi nimetada bill, bill_group, bill_file.
