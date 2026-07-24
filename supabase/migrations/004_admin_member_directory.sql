-- Allow authenticated coaches to view member identity and sign-in metadata
-- from the admin dashboard without exposing auth.users directly.
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
  if not public.is_coach() then
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
