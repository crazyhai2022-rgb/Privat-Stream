-- viralX: creators choose who can see a video. public = listed everywhere, unlisted = only people with the link, private = only the creator and staff.
alter table videos add column visibility text not null default 'public' check (visibility in ('public', 'unlisted', 'private'));
create index videos_visibility_idx on videos (visibility) where visibility <> 'public';
