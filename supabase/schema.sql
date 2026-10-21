-- Run this in Supabase Dashboard > SQL Editor.
-- The service-role key is used only by server routes; never expose it to the browser.
create table if not exists public.app_users (
  id bigint generated always as identity primary key,
  username varchar(24) not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  constraint app_users_username_format check (username ~ '^[A-Za-z0-9_]{3,24}$')
);

-- Usernames are unique case-insensitively so Alex and alex cannot both register.
create unique index if not exists app_users_username_lower_unique
  on public.app_users (lower(username));

-- Do not enable public access. The server uses SUPABASE_SERVICE_ROLE_KEY.
alter table public.app_users enable row level security;
revoke all on public.app_users from anon, authenticated;


-- Per-user search history (only server-side service role can access this table).
create table if not exists public.check_history (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.app_users(id) on delete cascade,
  input text not null check (char_length(input) between 4 and 1000),
  status text not null,
  verdict text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists check_history_user_created_idx
  on public.check_history (user_id, created_at desc);
alter table public.check_history enable row level security;
revoke all on public.check_history from anon, authenticated;

-- Database-backed rate limiting works across serverless instances.
create table if not exists public.rate_limit_buckets (
  rate_key text primary key,
  window_started_at timestamptz not null,
  attempts integer not null default 0
);
alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from anon, authenticated;

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_bucket public.rate_limit_buckets%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if p_limit < 1 or p_window_seconds < 1 or length(p_key) > 200 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_key));
  select * into current_bucket
    from public.rate_limit_buckets
    where rate_key = p_key
    for update;

  if not found then
    insert into public.rate_limit_buckets(rate_key, window_started_at, attempts)
    values (p_key, now_at, 1)
    on conflict (rate_key) do nothing;
    select * into current_bucket
      from public.rate_limit_buckets
      where rate_key = p_key
      for update;
  end if;

  if now_at >= current_bucket.window_started_at + make_interval(secs => p_window_seconds) then
    update public.rate_limit_buckets
      set window_started_at = now_at, attempts = 1
      where rate_key = p_key;
    return true;
  end if;

  if current_bucket.attempts >= p_limit then
    return false;
  end if;

  update public.rate_limit_buckets
    set attempts = attempts + 1
    where rate_key = p_key;
  return true;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

-- Periodic cleanup can be scheduled in Supabase if this table becomes large:
-- delete from public.rate_limit_buckets where window_started_at < now() - interval '2 days';
