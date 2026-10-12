const db = require('./db');

// X-Forwarded-For can be a chain ("client, proxy1, proxy2"); the first entry
// is the original caller. Absent when there's no proxy in front.
function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (header) return String(header).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

// Fire-and-forget-safe: a logging failure must never break the operation it's
// attached to — every error here is caught and printed, never thrown.
// Details must never carry extracted values (patient data) — only ids, counts
// and labels.
async function logAction({ actorUserId, targetUserId, entityType, entityId, action, details, req }) {
  try {
    const ipAddress = req ? clientIp(req) : null;
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, entity_type, entity_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        actorUserId || null,
        targetUserId || null,
        entityType || null,
        entityId != null ? String(entityId) : null,
        action,
        details ? JSON.stringify(details) : null,
        ipAddress,
      ],
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
