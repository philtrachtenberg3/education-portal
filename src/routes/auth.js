'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const { audit } = require('../lib/audit');

const router = express.Router();

const HOME = { student: '/dashboard', instructor: '/teach', admin: '/admin' };
const homeFor = (user) => HOME[user.role];

// Only allow local redirects after login.
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);

const demoAccounts = () => (process.env.NODE_ENV === 'production' ? [] : db.prepare(`
  SELECT name, email, role FROM users WHERE email LIKE '%@demo.example.edu'
  ORDER BY CASE role WHEN 'student' THEN 0 WHEN 'instructor' THEN 1 ELSE 2 END, name`).all());

router.get('/', (req, res) => res.redirect(req.user ? homeFor(req.user) : '/login'));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('login', { title: 'Sign in', error: null, email: '', next: req.query.next || '', demo: demoAccounts() });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const key = `${req.ip}|${email.toLowerCase()}`;
  const fail = (msg) => {
    res.status(401);
    return res.render('login', { title: 'Sign in', error: msg, email, next: req.body.next || '', demo: demoAccounts() });
  };
  if (auth.loginThrottled(key)) return fail('Too many sign-in attempts. Wait 15 minutes and try again.');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(user, password) || user.status !== 'active') {
    auth.recordLoginFailure(key);
    return fail('That email and password combination was not recognised.');
  }
  auth.clearLoginFailures(key);
  auth.createSession(res, user.id);
  if (user.role === 'admin') audit({ actorId: user.id, action: 'admin.sign_in', entityType: 'user', entityId: user.id });
  return res.redirect(safeNext(req.body.next) || homeFor(user));
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

module.exports = router;
module.exports.homeFor = homeFor;
