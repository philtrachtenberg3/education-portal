'use strict';
const path = require('path');
const express = require('express');
const { db } = require('./db');
const { sessionMiddleware, csrfProtect, requireLogin } = require('./lib/auth');
const { loadCourse } = require('./lib/authz');
const { unreadCount, runReminders } = require('./lib/notify');
const time = require('./lib/time');
const { STATUS, KIND_LABEL } = require('./lib/coursework');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    // Inline style attributes carry per-course accent colours; scripts remain same-origin only.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(sessionMiddleware);

// View helpers. Times always render in the signed-in user's zone, with the zone shown.
app.use((req, res, next) => {
  const tz = req.user?.timezone || 'UTC';
  Object.assign(res.locals, {
    user: req.user,
    csrfToken: req.csrfToken,
    path: req.path,
    query: req.query,
    tz,
    unread: req.user ? unreadCount(req.user.id) : 0,
    STATUS, KIND_LABEL,
    fmt: {
      dateTime: (iso) => time.fmtDateTime(iso, tz),
      date: (iso) => time.fmtDate(iso, tz),
      time: (iso) => time.fmtTime(iso, tz),
      timeTz: (iso) => time.dt(iso, tz).toFormat('h:mm a ZZZZ'),
      inZone: (iso, zone) => time.fmtDateTime(iso, zone),
      range: (a, b) => time.fmtTimeRange(a, b, tz),
      rel: (iso) => time.relative(iso),
      input: (iso, zone) => time.toLocalInput(iso, zone || tz),
      points: (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1)),
      size: (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`),
    },
    flash: res.locals.flash || null,
  });
  next();
});

// After view locals, so a rejected request can still render the error page.
app.use(csrfProtect);

app.use(require('./routes/auth'));
app.use(require('./routes/student'));
app.use(require('./routes/teach'));
app.use(require('./routes/account'));
app.use('/admin', require('./routes/admin'));

const courseScoped = [
  requireLogin,
  (req, res, next) => loadCourse(req, res, next, req.params.courseId),
];
app.use('/courses/:courseId', courseScoped,
  require('./routes/course'),
  require('./routes/materials'),
  require('./routes/assignments'),
  require('./routes/grading'),
  require('./routes/groups'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'This page does not exist or you do not have access to it.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'The request could not be completed and nothing was saved. Please try again.' });
});

if (require.main === module) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (!count) {
    console.log('Empty database — loading demo data…');
    require('./seed').seed();
  }
  runReminders();
  setInterval(runReminders, 10 * 60e3).unref();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Student Learning Portal running at http://localhost:${port}`));
}

module.exports = app;
