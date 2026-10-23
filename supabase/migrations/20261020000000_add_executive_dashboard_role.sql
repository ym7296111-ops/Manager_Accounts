-- Add a least-privilege executive role for dashboard-only access.
insert into public.roles (slug, name_ar, name_en, description, is_system)
values ('executive', 'الإدارة العليا', 'Executive', 'عرض لوحة التحكم فقط', true)
on conflict (slug) do nothing;

insert into public.permissions (slug, module, name_ar, name_en, description)
values ('dashboard:read', 'dashboard', 'قراءة لوحة التحكم', 'Read dashboard', 'قراءة لوحة المؤشرات العامة')
on conflict (slug) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r
  join public.permissions p on p.slug = 'dashboard:read'
 where r.slug = 'executive'
on conflict do nothing;
