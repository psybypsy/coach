-- The system admin is a separate permission from the coach role.
-- Resolve the fixed admin identity from auth.users so clients cannot grant
-- themselves access by changing profile data or user metadata.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users
    where id = auth.uid()
      and lower(email) = 'psybypsy01@gmail.com'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Give the system admin read access to private member content needed by /admin.
create policy "admin read all entries"
  on public.perma_entries for select to authenticated
  using (public.is_admin());

create policy "admin read all weekly reviews"
  on public.weekly_reviews for select to authenticated
  using (public.is_admin());

-- Allow only the system admin to view identity and sign-in metadata
-- without exposing auth.users directly.
create or replace function public.admin_list_members()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  joined_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception '管理者權限不足' using errcode = '42501';
  end if;

  return query
    select
      p.id,
      u.email::text,
      p.display_name,
      p.role,
      p.created_at,
      u.last_sign_in_at
    from public.profiles p
    left join auth.users u on u.id = p.id
    order by p.created_at asc;
end;
$$;

revoke all on function public.admin_list_members() from public;
grant execute on function public.admin_list_members() to authenticated;
