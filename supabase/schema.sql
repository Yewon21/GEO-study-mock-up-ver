-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query → Run).
-- Creates a single key/value table that mirrors the app's existing local-storage
-- keys (folders, cards:<id>, mapnotes:<key>, reviewHistory, ...), scoped per user
-- so every signed-in account only ever sees its own rows.

create table if not exists public.kv_store (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.kv_store enable row level security;

create policy "kv_store_select_own" on public.kv_store
  for select using (auth.uid() = user_id);

create policy "kv_store_insert_own" on public.kv_store
  for insert with check (auth.uid() = user_id);

create policy "kv_store_update_own" on public.kv_store
  for update using (auth.uid() = user_id);

create policy "kv_store_delete_own" on public.kv_store
  for delete using (auth.uid() = user_id);
