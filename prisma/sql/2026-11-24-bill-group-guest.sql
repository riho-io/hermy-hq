-- Arvete külaline (BILLS_GUEST_EMAILS): näeb ainult plokke, kus guest_visible = true.
-- Ainult uus veerg olemasolevas tabelis; RLS ja õigused (2026-11-21-bills.sql) jäävad samaks.
alter table hermyhq.bill_group
  add column if not exists guest_visible boolean not null default false;

-- Kontroll:
-- select name, guest_visible from hermyhq.bill_group order by sort_order;
