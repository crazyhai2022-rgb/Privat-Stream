export const userDto = (u) => u && ({
  id: u.id,
  full_name: u.full_name,
  email: u.email,
  role: u.role,
  email_verified: !!u.email_verified_at,
  account_status: u.account_status,
  created_at: u.created_at,
});

export const imageUrl = (key) => (key ? `/media/img/${key}` : null);

export const channelDto = (c, extra = {}) => c && ({
  id: c.id,
  name: c.name,
  handle: c.handle,
  bio: c.bio,
  avatar_url: imageUrl(c.avatar_key),
  banner_url: imageUrl(c.banner_key),
  status: c.status,
  status_reason: c.status_reason || null,
  telegram_url: c.telegram_url || null,
  telegram_enabled: c.telegram_enabled,
  created_at: c.created_at,
  ...extra,
});

export const canUpload = (user, channel) =>
  !!(user && user.email_verified_at && user.account_status === 'active' && channel && channel.status === 'approved');
