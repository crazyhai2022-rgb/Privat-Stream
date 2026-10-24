import { db } from '../db/index.js';

export const DEFAULT_CATEGORIES = [
  ['entertainment', 'Entertainment'], ['education', 'Education'], ['music', 'Music'], ['gaming', 'Gaming'],
  ['tech', 'Technology'], ['sports', 'Sports'], ['lifestyle', 'Lifestyle'], ['news', 'News'],
];

// Seeds a starter category list once (only when the table is empty).
export async function ensureDefaultCategories() {
  const { n } = await db.one('select count(*)::int as n from categories');
  if (n > 0) return;
  let i = 0;
  for (const [slug, name] of DEFAULT_CATEGORIES) {
    await db.query('insert into categories (slug, name, sort_order) values ($1,$2,$3) on conflict do nothing', [slug, name, i++]);
  }
}
