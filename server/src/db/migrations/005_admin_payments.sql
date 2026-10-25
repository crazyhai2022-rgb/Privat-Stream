-- viralX: Super Admin Creator Payments permission. Moderators never see payment data.
update admin_roles set permissions = array_append(permissions, 'payments')
 where role = 'super_admin' and not ('payments' = any(permissions));
