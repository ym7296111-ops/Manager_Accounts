-- Add the dedicated Project Settings capability without changing the RBAC
-- schema or any existing permission/role grant. The owner auto-grant trigger
-- installed by 20261016120000 also covers this new catalogue row.

insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'project.settings:manage',
  'app',
  'ضبط المشروع',
  'Manage project settings',
  'تعديل هوية المشروع وبيانات المسؤول والشعار وأيقونة المتصفح'
)
on conflict (slug) do nothing;

notify pgrst, 'reload schema';
