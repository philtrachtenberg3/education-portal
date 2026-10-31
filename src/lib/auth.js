'use strict';
// Session authentication with server-side sessions stored in SQLite.
// This is a replaceable module: institutional SSO (SAML/OIDC) would establish
// the same `req.user` and session row after the identity provider callback.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const COOKIE = 'slp_sid';
const SESSION_HOURS = 12;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?,?,?,?)').run(id, userId, csrf, expires);
  setCookie(res, id, SESSION_HOURS * 3600);
}

function destroySession(req, res) {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  setCookie(res, '', 0);
}

// Loads req.user, req.csrfToken and flash messages for every request.
function sessionMiddleware(req, res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null;
  if (sid) {
    const row = db.prepare(`
      SELECT s.csrf_token, s.flash, s.expires_at, u.id AS user_id, u.name, u.email, u.role, u.status,
             u.timezone, u.email_notifications, u.reminder_hours
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`).get(sid);
    if (row && row.expires_at > new Date().toISOString() && row.status === 'active') {
      req.sessionId = sid;
      req.csrfToken = row.csrf_token;
      req.user = {
        id: row.user_id, name: row.name, email: row.email, role: row.role, timezone: row.timezone,
        email_notifications: row.email_notifications, reminder_hours: row.reminder_hours,
      };
      if (row.flash) {
        res.locals.flash = JSON.parse(row.flash);
        db.prepare('UPDATE sessions SET flash = NULL WHERE id = ?').run(sid);
      }
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    }
  }
  req.flash = (type, message) => {
    if (!req.sessionId) return;
    db.prepare('UPDATE sessions SET flash = ? WHERE id = ?').run(JSON.stringify({ type, message }), req.sessionId);
  };
  next();
}

function csrfValid(req) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (!req.csrfToken || !token || token.length !== req.csrfToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.csrfToken));
}

// Rejects state-changing requests without a valid CSRF token. Multipart routes
// call `csrfCheck` explicitly after the upload parser has populated req.body.
function csrfProtect(req, res, next) {
  if (req.method !== 'POST' || req.is('multipart/form-data') || req.path === '/login') return next();
  return csrfCheck(req, res, next);
}

function csrfCheck(req, res, next) {
  if (!req.user || csrfValid(req)) return next();
  res.status(403);
  return res.render('error', { title: 'Form expired', message: 'This form has expired or was submitted from another site. Go back, refresh the page and try again.' });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (roles.includes(req.user.role)) return next();
    res.status(403);
    return res.render('error', { title: 'Not available', message: 'Your account does not have access to this page.' });
  };
}

// Small in-memory throttle to slow password guessing in the prototype.
const attempts = new Map();
function loginThrottled(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, first: now };
  if (now - rec.first > 15 * 60e3) { rec.count = 0; rec.first = now; }
  return rec.count >= 10;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, first: now };
  rec.count += 1;
  attempts.set(key, rec);
}
function clearLoginFailures(key) { attempts.delete(key); }

function verifyPassword(user, password) {
  return user && bcrypt.compareSync(password, user.password_hash);
}

const hashPassword = (pw) => bcrypt.hashSync(pw, 10);

module.exports = {
  sessionMiddleware, csrfProtect, csrfCheck, requireLogin, requireRole, createSession, destroySession,
  verifyPassword, hashPassword, loginThrottled, recordLoginFailure, clearLoginFailures,
};
