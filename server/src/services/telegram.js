import { getSetting } from './settings.js';

const ALLOWED_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog', 'www.t.me', 'www.telegram.me']);

// Returns a normalised https URL if `value` is an allowed Telegram link, else null.
export function normalizeTelegramUrl(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (/^@[A-Za-z0-9_]{4,32}$/.test(raw)) raw = `https://t.me/${raw.slice(1)}`;
  if (/^(t\.me|telegram\.me)\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (u.username || u.password) return null;
  if (u.pathname.length < 2) return null;
  return u.toString();
}

/**
 * Resolution priority:
 *  1. Global link wins when the Super Admin has locked it.
 *  2. Creator link, when valid, enabled and creator overrides are allowed.
 *  3. Global link.
 *  4. Nothing -> { url: null, source: 'none' } (clients hide the button).
 */
export async function resolveTelegram(channel) {
  const t = await getSetting('telegram');
  const globalUrl = normalizeTelegramUrl(t.global_url);
  if (t.locked && globalUrl) return { url: globalUrl, source: 'global_locked' };
  if (t.allow_creator_override && channel?.telegram_enabled !== false) {
    const own = normalizeTelegramUrl(channel?.telegram_url);
    if (own) return { url: own, source: 'creator' };
  }
  if (globalUrl) return { url: globalUrl, source: 'global' };
  return { url: null, source: 'none' };
}
