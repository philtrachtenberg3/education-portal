'use strict';
// Append-only audit log for grade, membership, publication and admin changes.
// Only summaries of changed fields are stored — never passwords, tokens or file contents.

const { db, nowIso } = require('../db');

const insert = db.prepare(`
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, course_id, before_json, after_json, reason, created_at)
  VALUES (@actor_id, @action, @entity_type, @entity_id, @course_id, @before_json, @after_json, @reason, @created_at)`);

function audit({ actorId, action, entityType, entityId = null, courseId = null, before = null, after = null, reason = null }) {
  insert.run({
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    course_id: courseId,
    before_json: before == null ? null : JSON.stringify(before),
    after_json: after == null ? null : JSON.stringify(after),
    reason: reason || null,
    created_at: nowIso(),
  });
}

module.exports = { audit };
