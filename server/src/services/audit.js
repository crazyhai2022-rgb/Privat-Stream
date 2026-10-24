import { db } from '../db/index.js';
import { ipHash } from '../lib/crypto.js';

export async function audit(req, action, targetType, targetId, metadata = {}, actorId) {
  try {
    await db.query(
      `insert into audit_logs (actor_id, action, target_type, target_id, metadata, ip_hash)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [actorId ?? req?.user?.id ?? null, action, targetType || null, targetId ? String(targetId) : null,
        JSON.stringify(metadata || {}), req ? ipHash(req.ip) : null],
    );
  } catch (e) {
    console.error('audit log failed', e.message);
  }
}

export async function recordModeration({ adminId, videoId, commentId, userId, action, note }) {
  await db.query(
    `insert into moderation_actions (admin_id, video_id, comment_id, user_id, action, note) values ($1,$2,$3,$4,$5,$6)`,
    [adminId || null, videoId || null, commentId || null, userId || null, action, note || null],
  );
}
