-- viralX: Super Admin visitor analytics permission.
update admin_roles set permissions = array_append(permissions, 'analytics')
 where role = 'super_admin' and not ('analytics' = any(permissions));
