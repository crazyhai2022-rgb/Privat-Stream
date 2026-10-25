-- Approved creators publish without a per-video review. The admin can still turn
-- per-video review back on in Platform settings -> Moderation.
insert into settings (key, value) values ('moderation', '{"require_video_moderation": false}'::jsonb)
on conflict (key) do update set value = settings.value || '{"require_video_moderation": false}'::jsonb;

-- Videos already waiting from approved creators go live.
update videos v set status = 'published', published_at = coalesce(v.published_at, now()), updated_at = now()
 where v.status = 'pending_moderation'
   and exists (select 1 from channels c join users u on u.id = c.user_id
                where c.id = v.channel_id and c.status = 'approved' and u.account_status = 'active');
