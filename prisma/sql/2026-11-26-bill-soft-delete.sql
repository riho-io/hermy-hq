-- Arvete pehme kustutamine: kustutatud arve saab /arved lehel taastada.
-- Ainult uus veerg olemasolevas tabelis; RLS ja õigused (2026-11-21-bills.sql) jäävad samaks.
alter table hermyhq.bill
  add column if not exists deleted_at timestamptz;

-- Kontroll:
-- select count(*) from hermyhq.bill where deleted_at is not null;
