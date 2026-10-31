'use strict';
// Demo data: fictional people and courses only. Dates are relative to "now" so the
// dashboard always has upcoming work, past-due items and a current timetable.
// `npm run seed` wipes the local database and uploads, then reloads this data.

const fs = require('fs');
const path = require('path');

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  for (const f of ['portal.db', 'portal.db-wal', 'portal.db-shm', 'email-outbox.log']) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
}

const { db } = require('./db');
const { hashPassword } = require('./lib/auth');
const storage = require('./lib/storage');
const { DateTime } = require('./lib/time');

const TZ = 'America/New_York';
const DEMO_PASSWORD = 'demo1234';

// A tiny but valid one-page PDF so demo downloads open in any viewer.
function makePdf(title, lines) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => '\\' + m);
  const text = [`BT /F1 18 Tf 72 720 Td (${esc(title)}) Tj /F1 11 Tf`, ...lines.map((l) => `0 -18 Td (${esc(l)}) Tj`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

function seed() {
  const now = DateTime.now().setZone(TZ);
  // Due "N days from now at HH:MM" in the course zone, stored as UTC.
  const at = (days, hh = 23, mm = 59) => now.plus({ days }).set({ hour: hh, minute: mm, second: 0, millisecond: 0 }).toUTC().toISO();
  const ago = (days, hh = 12) => at(-days, hh, 0);
  const hash = hashPassword(DEMO_PASSWORD);

  const run = db.transaction(() => {
    const user = (name, local, role) => db.prepare('INSERT INTO users (name, email, password_hash, role, timezone) VALUES (?,?,?,?,?)')
      .run(name, `${local}@demo.example.edu`, hash, role, TZ).lastInsertRowid;

    const maya = user('Maya Okafor', 'maya.okafor', 'student');
    const daniel = user('Daniel Reyes', 'daniel.reyes', 'student');
    const priya = user('Priya Natarajan', 'priya.natarajan', 'student');
    const tom = user('Tom Lindqvist', 'tom.lindqvist', 'student');
    const aisha = user('Aisha Bello', 'aisha.bello', 'student');
    const lucas = user('Lucas Moreau', 'lucas.moreau', 'student');
    const hannah = user('Hannah Kim', 'hannah.kim', 'student');
    const omar = user('Omar Haddad', 'omar.haddad', 'student');
    const vasquez = user('Dr. Elena Vasquez', 'elena.vasquez', 'instructor');
    const whitfield = user('Prof. James Whitfield', 'james.whitfield', 'instructor');
    const chen = user('Dr. Samira Chen', 'samira.chen', 'instructor');
    user('Alex Morgan (Registrar Ops)', 'admin', 'admin');

    const termStart = now.minus({ weeks: 9 }).startOf('week');
    const termEnd = termStart.plus({ weeks: 16 }).minus({ days: 3 });
    const term = db.prepare('INSERT INTO terms (name, start_date, end_date) VALUES (?,?,?)')
      .run(`Fall ${termStart.year}`, termStart.toISODate(), termEnd.toISODate()).lastInsertRowid;
    db.prepare('INSERT INTO terms (name, start_date, end_date) VALUES (?,?,?)')
      .run(`Spring ${termStart.year + 1}`, termEnd.plus({ weeks: 4 }).startOf('week').toISODate(), termEnd.plus({ weeks: 20 }).toISODate());

    const course = (code, title, color, description, policy, showTotal) => db.prepare(
      'INSERT INTO courses (code, title, term_id, color, description, grading_policy, show_total) VALUES (?,?,?,?,?,?,?)')
      .run(code, title, term, color, description, policy, showTotal).lastInsertRowid;

    const cs = course('CS 220', 'Data Structures and Algorithms', '#2f5bd3',
      'How to choose, implement and analyse the data structures behind real software: lists, hash tables, trees, heaps and graphs. Weekly problem sets in Python, a paired project, and labs on profiling and testing.',
      'Problem sets 40%, labs 15%, quizzes 10%, project 35%. The portal shows an unweighted running total of released items only.', 1);
    const env = course('ENV 210', 'Climate Science and Policy', '#1d7a52',
      'The physical basis of climate change and the policy tools societies use to respond. Seminars combine readings, data exercises and team policy briefs written for a real municipal audience.',
      'Reading responses 20%, field notes 15%, team charter 5%, policy brief 35%, final reflection 25%. Course totals are calculated at the end of term.', 0);
    const hist = course('HIST 145', 'The Modern World, 1750–Present', '#a3471b',
      'Revolutions, industrialisation, empire and their afterlives. Weekly lectures with tutorials focused on reading primary sources critically and building historical arguments.',
      'Essays 50%, source analyses 20%, map quiz 5%, tutorial participation 25%.', 0);
    const stat = course('STAT 201', 'Introduction to Statistics', '#7a3fb0',
      'Describing data, probability, sampling distributions, confidence intervals and hypothesis tests, with weekly homework in R.',
      'Homework 40%, midterm 25%, final exam 35%. The portal total below is an unweighted provisional figure for released homework only.', 1);

    const enroll = (u, c, role = 'student', nickname = null) => db.prepare('INSERT INTO enrollments (user_id, course_id, role, nickname, start_date) VALUES (?,?,?,?,?)')
      .run(u, c, role, nickname, termStart.toISODate());
    enroll(vasquez, cs, 'instructor'); enroll(whitfield, env, 'instructor'); enroll(chen, hist, 'instructor'); enroll(whitfield, stat, 'instructor');
    enroll(maya, cs); enroll(maya, env, 'student', 'Climate seminar'); enroll(maya, hist); enroll(maya, stat);
    for (const s of [daniel, hannah, lucas, omar]) enroll(s, cs);
    for (const s of [daniel, priya, tom, aisha, lucas, hannah, omar]) enroll(s, env);
    for (const s of [priya, tom, aisha]) enroll(s, hist);
    for (const s of [daniel, priya, aisha, omar]) enroll(s, stat);

    // ----- Timetable -----
    const meeting = (c, title, kind, weekday, start, end, location, url = null) => db.prepare(`
      INSERT INTO class_meetings (course_id, title, kind, weekday, start_time, end_time, timezone, location, meeting_url, first_date, last_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c, title, kind, weekday, start, end, TZ, location, url, termStart.toISODate(), termEnd.toISODate()).lastInsertRowid;
    const csLecMon = meeting(cs, 'Lecture', 'lecture', 1, '10:00', '11:15', 'Engineering Hall 204');
    meeting(cs, 'Lecture', 'lecture', 3, '10:00', '11:15', 'Engineering Hall 204');
    meeting(cs, 'Lab', 'lab', 5, '14:00', '15:50', 'Computing Lab B (Engineering Hall 015)');
    meeting(env, 'Seminar', 'seminar', 2, '13:00', '14:15', 'Hartley Building 112');
    const envThu = meeting(env, 'Seminar', 'seminar', 4, '13:00', '14:15', 'Hartley Building 112', 'https://meet.example.edu/env210');
    meeting(hist, 'Lecture', 'lecture', 2, '09:30', '10:45', 'Humanities Lecture Hall A');
    meeting(hist, 'Tutorial', 'tutorial', 4, '11:00', '11:50', 'Humanities 3.07');
    meeting(stat, 'Lecture', 'lecture', 1, '14:30', '15:45', 'Science Centre 150');
    meeting(stat, 'Lecture', 'lecture', 3, '14:30', '15:45', 'Science Centre 150');

    // Next week's Monday CS lecture is cancelled; next Thursday's ENV seminar moves rooms.
    const nextMon = now.plus({ weeks: 1 }).startOf('week');
    db.prepare('INSERT INTO meeting_exceptions (meeting_id, date, status, note) VALUES (?,?,?,?)').run(csLecMon, nextMon.toISODate(), 'cancelled', 'Dr. Vasquez is at a conference. Watch the recorded mini-lecture in Materials instead.');
    db.prepare('INSERT INTO meeting_exceptions (meeting_id, date, status, location, note) VALUES (?,?,?,?,?)').run(envThu, nextMon.plus({ days: 3 }).toISODate(), 'changed', 'Library Seminar Room 2', 'Moved for the data-visualisation workshop.');

    const event = (c, title, kind, startDays, sh, eh, location, url = null) => db.prepare(`
      INSERT INTO events (course_id, title, kind, starts_at, ends_at, location, meeting_url) VALUES (?,?,?,?,?,?,?)`)
      .run(c, title, kind, at(startDays, sh, 0), at(startDays, eh, 0), location, url);
    event(stat, 'Midterm exam (chapters 1–7)', 'exam', 10, 18, 20, 'Science Centre 150 & 152');
    event(hist, 'Essay-writing workshop (optional)', 'event', 6, 16, 17, 'Writing Centre, Library level 2');
    event(env, 'Guest talk: City resilience office', 'event', 8, 17, 18, 'Online', 'https://meet.example.edu/env210-guest');

    // ----- Announcements -----
    const announce = (c, author, title, body, daysAgo) => db.prepare(
      'INSERT INTO announcements (course_id, author_id, title, body, published, created_at) VALUES (?,?,?,?,1,?)').run(c, author, title, body, ago(daysAgo, 9));
    announce(cs, vasquez, 'No lecture next Monday', `I am presenting at a conference, so Monday's lecture (${nextMon.toFormat('d LLL')}) is cancelled. A 25-minute recorded mini-lecture on AVL rotations is in Materials → Week 9. Wednesday's lecture goes ahead as normal.`, 1);
    announce(cs, vasquez, 'Project 2 pairs', 'Form your Project 2 pairs on the Groups page by the membership deadline. If you cannot find a partner, email me and I will match you.', 6);
    announce(env, whitfield, 'Policy brief teams confirmed', 'Teams for the policy brief are confirmed on the Groups page. One person submits for the whole team; everyone listed is credited automatically.', 3);
    announce(hist, chen, 'Essay 1 feedback timeline', 'Thank you for your Essay 1 submissions. I aim to return grades and comments by the end of next week.', 2);
    announce(stat, whitfield, 'Midterm room allocation', 'Surnames A–L sit in Science Centre 150; M–Z in 152. Bring a calculator; a formula sheet is provided.', 4);

    // ----- Materials -----
    const mod = (c, title, pos) => db.prepare('INSERT INTO modules (course_id, title, position) VALUES (?,?,?)').run(c, title, pos).lastInsertRowid;
    const csW7 = mod(cs, 'Week 7 · Hash tables', 1);
    const csW8 = mod(cs, 'Week 8 · Trees and traversals', 2);
    const csW9 = mod(cs, 'Week 9 · Balanced trees', 3);
    const csRef = mod(cs, 'Course references', 4);
    addResource(cs, csW7, 'lecture', 'Lecture 13 slides: Hashing and collision resolution', 'Chaining vs open addressing, load factor and resizing, with worked examples.', vasquez, { file: ['Hash functions map keys to buckets.', 'Separate chaining stores collisions in lists.', 'Open addressing probes for the next free slot.', 'Keep load factor below 0.75 and resize by doubling.'], daysAgo: 18 });
    addResource(cs, csW7, 'reading', 'Reading: Hash tables (course notes ch. 6)', 'Required before Problem Set 4. Sections 6.1–6.4.', vasquez, { file: ['Chapter 6: Hash tables', '6.1 Direct addressing', '6.2 Hash functions', '6.3 Collision resolution', '6.4 Amortised resizing'], daysAgo: 18 });
    addResource(cs, csW8, 'lecture', 'Lecture 15 slides: Binary search trees', 'BST invariants, insertion, deletion and in-order traversal.', vasquez, { file: ['A BST keeps left < node < right.', 'In-order traversal yields sorted output.', 'Deletion has three cases.'], daysAgo: 11 });
    addResource(cs, csW8, 'activity', 'Lab 6 handout: Profiling with cProfile', 'Instructions and starter code description for the profiling lab.', vasquez, { file: ['Lab 6: Profiling', 'Run cProfile on the provided word-count script.', 'Identify the hottest function and propose one fix.'], daysAgo: 9 });
    addResource(cs, csW9, 'recording', 'Recorded mini-lecture: AVL rotations (25 min)', 'Replaces the cancelled Monday lecture. Captions available.', vasquez, { url: 'https://media.example.edu/cs220/avl-rotations', daysAgo: 1 });
    addResource(cs, csW9, 'lecture', 'Lecture 17 slides: Red-black trees', 'Draft — will be published after Wednesday’s lecture.', vasquez, { file: ['Red-black tree properties', 'Recolouring and rotations'], published: 0, daysAgo: 0 });
    addResource(cs, csRef, 'reference', 'Big-O cheat sheet', 'Time and space complexity of common operations for every structure in the course.', vasquez, { file: ['Array access O(1)', 'Hash table lookup O(1) average', 'BST search O(log n) balanced, O(n) worst', 'Heap insert O(log n)'], daysAgo: 60 });
    addResource(cs, csRef, 'reference', 'Python style guide for submissions', 'Follow this for all problem sets: naming, docstrings and tests.', vasquez, { url: 'https://peps.python.org/pep-0008/', daysAgo: 60 });

    const envW8 = mod(env, 'Week 8 · Adaptation and resilience', 1);
    const envW9 = mod(env, 'Week 9 · Policy instruments', 2);
    const envBrief = mod(env, 'Policy brief toolkit', 3);
    addResource(env, envW8, 'reading', 'IPCC AR6 Synthesis Report — Summary for Policymakers', 'Read sections A and B before Tuesday’s seminar.', whitfield, { url: 'https://www.ipcc.ch/report/ar6/syr/', daysAgo: 16 });
    addResource(env, envW8, 'lecture', 'Seminar slides: Coastal adaptation pathways', 'Managed retreat, protection and accommodation; case studies from three cities.', whitfield, { file: ['Adaptation pathways', 'Protect: sea walls and surge barriers', 'Accommodate: elevating and flood-proofing', 'Retreat: buyouts and rezoning'], daysAgo: 12 });
    addResource(env, envW9, 'reading', 'Carbon pricing: a short primer', 'Compares carbon taxes and cap-and-trade, with design trade-offs.', whitfield, { file: ['Carbon pricing primer', 'Carbon tax: price certainty', 'Cap-and-trade: quantity certainty', 'Border adjustments and revenue recycling'], daysAgo: 4 });
    addResource(env, envBrief, 'assessment', 'Policy brief rubric', 'How the team policy brief will be graded (35% of the course).', whitfield, { file: ['Policy brief rubric', 'Problem framing - 20', 'Evidence and analysis - 30', 'Options and recommendation - 30', 'Clarity for a non-specialist audience - 20'], daysAgo: 25 });
    addResource(env, envBrief, 'reference', 'Example policy brief (from a previous year, shared with permission)', 'An anonymised strong example on urban heat islands.', whitfield, { file: ['Urban heat: options for the city council', 'Summary', 'Context', 'Options', 'Recommendation'], daysAgo: 25 });

    const histW8 = mod(hist, 'Week 8 · Industrial revolutions', 1);
    const histW9 = mod(hist, 'Week 9 · Labour and reform', 2);
    const histSkills = mod(hist, 'Writing and research skills', 3);
    addResource(hist, histW8, 'lecture', 'Lecture slides: Steam, cotton and coal', 'Why Britain industrialised first — competing explanations.', chen, { file: ['Steam, cotton and coal', 'Resource endowments', 'High wages and cheap energy', 'Institutions and markets'], daysAgo: 13 });
    addResource(hist, histW8, 'reading', 'Primary source pack: Factory inspectors’ reports, 1833–1850', 'Excerpts for Thursday’s tutorial. Annotate before class.', chen, { file: ['Factory inspectors reports (excerpts)', 'Report of 1833 on child labour', 'Report of 1847 on working hours'], daysAgo: 13 });
    addResource(hist, histW9, 'reading', 'Engels, The Condition of the Working Class in England (selected chapters)', 'Chapters 2 and 3. Public-domain text.', chen, { url: 'https://www.gutenberg.org/ebooks/17306', daysAgo: 5 });
    addResource(hist, histSkills, 'reference', 'How to write a historical argument', 'Thesis, evidence, counter-argument and citation (Chicago notes-bibliography).', chen, { file: ['Writing a historical argument', 'State a clear, contestable thesis.', 'Support it with specific primary evidence.', 'Address the strongest counter-argument.'], daysAgo: 50 });

    const statW8 = mod(stat, 'Week 8 · Confidence intervals', 1);
    const statR = mod(stat, 'R help', 2);
    addResource(stat, statW8, 'lecture', 'Lecture 15 slides: Confidence intervals for a mean', 'Interpretation, the t distribution and common misreadings.', whitfield, { file: ['Confidence intervals', 'A 95% CI procedure captures the true mean in 95% of samples.', 'Use t when sigma is unknown.'], daysAgo: 8 });
    addResource(stat, statW8, 'recording', 'Lecture 15 recording', 'Captioned recording of Wednesday’s lecture.', whitfield, { url: 'https://media.example.edu/stat201/lecture-15', daysAgo: 7 });
    addResource(stat, statW8, 'activity', 'Practice problems with solutions: intervals', 'Ungraded. Try these before Homework 6.', whitfield, { file: ['Practice: confidence intervals', '1. n = 25, mean 72, s = 8: find a 95% CI.', '2. Explain what 95% confidence means.'], daysAgo: 6 });
    addResource(stat, statR, 'reference', 'R cheat sheet for STAT 201', 'The functions you need this term, on one page.', whitfield, { file: ['R for STAT 201', 'mean(x), sd(x), t.test(x)', 'qt(0.975, df)', 'ggplot(df, aes(x)) + geom_histogram()'], daysAgo: 55 });

    // ----- Groups -----
    const groupSet = (c, name, max, deadlineDays, studentCreated, approval) => db.prepare(
      'INSERT INTO group_sets (course_id, name, max_size, membership_deadline, student_created, requires_approval) VALUES (?,?,?,?,?,?)')
      .run(c, name, max, at(deadlineDays, 17, 0), studentCreated, approval).lastInsertRowid;
    const group = (setId, name, by, members, pending = []) => {
      const g = db.prepare('INSERT INTO groups (group_set_id, name, created_by, created_at) VALUES (?,?,?,?)').run(setId, name, by, ago(20)).lastInsertRowid;
      for (const [uid, status] of [...members.map((m) => [m, 'confirmed']), ...pending.map((m) => [m, 'pending'])]) {
        db.prepare('INSERT INTO group_memberships (group_id, group_set_id, user_id, status, decided_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(g, setId, uid, status, status === 'confirmed' ? by : null, ago(20), ago(20));
      }
      return g;
    };
    const envTeams = groupSet(env, 'Policy brief teams', 3, -2, 1, 1);
    const coastal = group(envTeams, 'Team Coastal', whitfield, [maya, daniel, priya]);
    group(envTeams, 'Team Carbon', whitfield, [tom, aisha], [omar]);
    group(envTeams, 'Team Urban Heat', whitfield, [lucas, hannah]);
    const csPairs = groupSet(cs, 'Project 2 pairs', 2, 5, 1, 0);
    group(csPairs, 'Pair: Okafor & Kim', maya, [maya, hannah]);
    group(csPairs, 'Pair: Reyes & Moreau', daniel, [daniel, lucas]);

    // ----- Assignments -----
    const assignment = (c, o) => db.prepare(`
      INSERT INTO assignments (course_id, title, kind, instructions, due_at, available_from, timezone, points, submission_types, allowed_extensions,
        max_file_mb, allow_resubmission, allow_late, late_policy, group_set_id, group_grading, published, created_at, updated_at)
      VALUES (@c, @title, @kind, @instructions, @due_at, @available_from, @tz, @points, @types, @ext, @mb, @resub, @late, @late_policy, @gs, @gg, @published, @created, @created)`)
      .run({ c, kind: 'assignment', available_from: null, tz: TZ, types: 'file', ext: 'pdf,docx', mb: 10, resub: 1, late: 1, late_policy: '', gs: null, gg: 'shared', published: 1, created: ago(30), ...o }).lastInsertRowid;
    const LATE_10 = 'Late work loses 10% per day, up to 3 days. After 3 days, contact the instructor.';

    const csPs3 = assignment(cs, { title: 'Problem Set 3: Linked lists', points: 100, due_at: ago(12, 23), types: 'file', ext: 'py,pdf,zip', late_policy: LATE_10,
      instructions: 'Implement a doubly linked list with insert, delete and reverse operations, then analyse the running time of each.\n\nSubmit your .py file and a short PDF with your analysis, or a single .zip containing both.' });
    assignment(cs, { title: 'Problem Set 4: Hash tables', points: 100, due_at: at(2), types: 'file', ext: 'py,pdf,zip', late_policy: LATE_10,
      instructions: 'Part A: implement a hash map with separate chaining and automatic resizing.\nPart B: compare the number of probes for linear and quadratic probing at load factors 0.5, 0.75 and 0.9.\n\nRead course notes chapter 6 first (Materials → Week 7). Include tests for every public method.' });
    assignment(cs, { title: 'Quiz 5: Tree traversals', kind: 'quiz', points: 20, due_at: at(5, 10, 0), types: 'text', resub: 0, late: 0,
      instructions: 'Write the pre-order, in-order and post-order traversal of the tree shown in Lecture 15, slide 12. One submission only; no late submissions.' });
    const csLab6 = assignment(cs, { title: 'Lab 6: Profiling', kind: 'task', points: 10, due_at: ago(3, 17), types: 'file,text', ext: 'pdf,txt,md',
      instructions: 'Upload your profiling report (PDF or Markdown) or paste your findings as text. Include the cProfile output for your fastest version.' });
    assignment(cs, { title: 'Project 2: Route planner', points: 150, due_at: at(16), types: 'file,link', ext: 'zip,pdf', mb: 25, gs: csPairs, gg: 'shared',
      instructions: 'In pairs, build a route planner over the provided transit graph using Dijkstra’s algorithm and an A* heuristic of your choice.\n\nSubmit a .zip of your code and a PDF report, or a link to your repository. One partner submits for the pair; both partners are credited.' });
    assignment(cs, { title: 'Problem Set 5: Graphs', points: 100, due_at: at(12), types: 'file', ext: 'py,pdf,zip', published: 0, late_policy: LATE_10,
      instructions: 'Breadth-first and depth-first search, topological sort and cycle detection. (Draft — not yet published.)' });

    const envRr = assignment(env, { title: 'Reading response: IPCC Summary for Policymakers', points: 20, due_at: ago(9, 23), types: 'text,file', ext: 'pdf,docx',
      instructions: 'In 400–600 words, identify one finding from the Summary for Policymakers that surprised you and explain its implications for coastal cities.' });
    const envCharter = assignment(env, { title: 'Team charter', points: 10, due_at: ago(15, 17), types: 'file', ext: 'pdf,docx', gs: envTeams, gg: 'individual',
      instructions: 'Agree roles, meeting times and how decisions are made. One team member submits; each member is graded individually on their section.' });
    const envField = assignment(env, { title: 'Field notes: Campus energy audit', kind: 'task', points: 15, due_at: ago(2, 17), types: 'file,text', ext: 'pdf,docx,jpg,png', late_policy: 'Accepted up to one week late for full credit with a short note explaining the delay.',
      instructions: 'Visit one campus building, record visible energy uses and inefficiencies, and suggest two low-cost improvements. Photos welcome.' });
    assignment(env, { title: 'Policy brief: Coastal adaptation options', points: 100, due_at: at(4, 17, 0), types: 'file', ext: 'pdf,docx', mb: 15, gs: envTeams, gg: 'shared',
      instructions: 'Write a 4-page policy brief for a city council choosing between protection, accommodation and managed retreat for one stretch of coastline. Use the rubric and example in Materials → Policy brief toolkit.\n\nOne team member submits for the whole team. Every confirmed member is credited and receives the shared grade.' });

    const histMap = assignment(hist, { title: 'Map quiz: Europe in 1815', kind: 'quiz', points: 10, due_at: ago(20, 10), types: 'text', resub: 0, late: 0,
      instructions: 'Label the twelve states on the Congress of Vienna map handed out in tutorial.' });
    const histSource = assignment(hist, { title: 'Primary source analysis: Factory inspectors’ reports', points: 30, due_at: ago(8, 23), types: 'file', ext: 'pdf,docx',
      instructions: 'Analyse two excerpts from the source pack: who wrote them, for whom, and what they reveal and conceal about factory work. 800 words.' });
    const histEssay1 = assignment(hist, { title: 'Essay 1: Causes of the French Revolution', points: 100, due_at: ago(6, 23), types: 'file', ext: 'pdf,docx',
      instructions: 'Was the French Revolution primarily caused by fiscal crisis? Answer in 1,800–2,200 words with Chicago-style footnotes.' });
    assignment(hist, { title: 'Essay proposal: Industrialisation and labour', points: 20, due_at: at(9), types: 'file', ext: 'pdf,docx', available_from: ago(2),
      instructions: 'Submit a one-page proposal for Essay 2: a working thesis, three primary sources you plan to use, and one question you still need to answer.' });

    const statHw5 = assignment(stat, { title: 'Homework 5: Sampling distributions', points: 50, due_at: ago(5, 17), types: 'file,text', ext: 'pdf,r,txt', late_policy: '5 points off per day late.',
      instructions: 'Problems 6.12, 6.18, 6.24 and 6.31. Include R code and output for the simulation questions.' });
    assignment(stat, { title: 'Homework 6: Confidence intervals', points: 50, due_at: at(1, 17, 0), types: 'file,text', ext: 'pdf,r,txt', late_policy: '5 points off per day late.',
      instructions: 'Problems 7.4, 7.10, 7.16 and 7.22. Show your working; interpret every interval in a full sentence.' });
    assignment(stat, { title: 'Weekly check-in', kind: 'task', points: 0, due_at: at(3, 12, 0), types: 'text', resub: 1,
      instructions: 'Two sentences: what is clicking for you, and what is still confusing? Ungraded — it shapes the next lecture.' });

    // ----- Submissions and grades -----
    let keyN = 0;
    const submit = (assignmentId, { student = null, groupId = null, by, daysAgo, late = 0, text = null, files = [], credits }) => {
      const t = ago(daysAgo, 20);
      const sid = db.prepare(`INSERT INTO submissions (assignment_id, student_id, group_id, status, current_version, first_submitted_at, last_submitted_at) VALUES (?,?,?,?,1,?,?)`)
        .run(assignmentId, student, groupId, late ? 'late' : 'submitted', t, t).lastInsertRowid;
      const vid = db.prepare(`INSERT INTO submission_versions (submission_id, version, submitted_by, submitted_at, is_late, body_text, idempotency_key) VALUES (?,1,?,?,?,?,?)`)
        .run(sid, by, t, late, text, `seed-${(keyN += 1)}`).lastInsertRowid;
      for (const [name, lines] of files) {
        const buf = makePdf(name, lines);
        db.prepare('INSERT INTO submission_files (version_id, original_name, stored_name, size, mime) VALUES (?,?,?,?,?)').run(vid, name, storage.save(buf, name), buf.length, 'application/pdf');
      }
      for (const s of credits || [student]) db.prepare('INSERT INTO submission_credits (submission_id, student_id, assignment_id) VALUES (?,?,?)').run(sid, s, assignmentId);
      return sid;
    };
    const grade = (assignmentId, student, points, feedback, { released = 1, excused = 0, grader, daysAgo = 3 } = {}) => {
      const g = db.prepare(`INSERT INTO grades (assignment_id, student_id, points, excused, feedback, released, released_at, grader_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(assignmentId, student, points, excused, feedback, released, released ? ago(daysAgo, 15) : null, grader, ago(daysAgo, 15)).lastInsertRowid;
      db.prepare(`INSERT INTO audit_events (actor_id, action, entity_type, entity_id, course_id, before_json, after_json, created_at)
        VALUES (?, 'grade.saved', 'grade', ?, (SELECT course_id FROM assignments WHERE id = ?), NULL, ?, ?)`)
        .run(grader, g, assignmentId, JSON.stringify({ points, excused: !!excused, released: !!released }), ago(daysAgo, 15));
    };

    // CS 220
    for (const [s, pts, fb] of [[maya, 87, 'Clean implementation and good tests. Your reverse() analysis should note that it is O(n) time but O(1) extra space — see the cheat sheet.'], [daniel, 92, 'Excellent analysis.'], [hannah, 78, 'Delete fails on a single-node list; otherwise solid.'], [lucas, 84, 'Good work.']]) {
      submit(csPs3, { student: s, by: s, daysAgo: 13, files: [['linked_list_analysis.pdf', ['Doubly linked list analysis', 'insert O(1) at head', 'delete O(n) search + O(1) unlink']]] });
      grade(csPs3, s, pts, fb, { grader: vasquez, daysAgo: 5 });
    }
    grade(csPs3, omar, 0, 'No submission received.', { grader: vasquez, daysAgo: 5 });
    submit(csLab6, { student: maya, by: maya, daysAgo: 4, files: [['lab6_profiling_report.pdf', ['Lab 6 profiling report', 'Hot spot: count_words() string concatenation', 'Fix: use collections.Counter - 6x faster']]] });
    submit(csLab6, { student: daniel, by: daniel, daysAgo: 4, text: 'Most time is spent in tokenize(); switching to str.split() cut runtime from 2.1s to 0.4s.' });
    submit(csLab6, { student: lucas, by: lucas, daysAgo: 2, late: 1, text: 'Profiled with cProfile; sorting dominated. Replaced with heapq.nlargest.' });

    // ENV 210
    for (const [s, pts] of [[maya, 18], [daniel, 16], [priya, 19], [tom, 17], [aisha, 18], [lucas, 15], [hannah, 17]]) {
      submit(envRr, { student: s, by: s, daysAgo: 10, text: 'The finding that adaptation limits are already being reached in some coastal systems surprised me…' });
      grade(envRr, s, pts, s === maya ? 'Thoughtful link between soft adaptation limits and municipal budgets. Next time cite the specific SPM section (e.g. B.4).' : 'Good response.', { grader: whitfield, daysAgo: 6 });
    }
    submit(envCharter, { groupId: coastal, by: daniel, daysAgo: 16, credits: [maya, daniel, priya], files: [['team_coastal_charter.pdf', ['Team Coastal charter', 'Roles: Daniel (editor), Maya (research lead), Priya (data)', 'We meet Tuesdays after seminar.']]] });
    grade(envCharter, maya, 10, 'Clear research plan.', { grader: whitfield, daysAgo: 12 });
    grade(envCharter, daniel, 9, 'Editing workflow could be more specific.', { grader: whitfield, daysAgo: 12 });
    grade(envCharter, priya, 10, 'Strong data-management plan.', { grader: whitfield, daysAgo: 12 });
    submit(envField, { student: priya, by: priya, daysAgo: 3, text: 'Audited the Hartley Building: lights on in empty rooms; recommend occupancy sensors.' });

    // HIST 145
    grade(histMap, maya, null, 'Excused — medical note received.', { excused: 1, grader: chen, daysAgo: 18 });
    for (const [s, pts] of [[priya, 9], [tom, 7], [aisha, 10]]) { submit(histMap, { student: s, by: s, daysAgo: 21, text: 'France, Prussia, Austria, …' }); grade(histMap, s, pts, '', { grader: chen, daysAgo: 18 }); }
    submit(histSource, { student: maya, by: maya, daysAgo: 9, files: [['source_analysis_okafor.pdf', ['Factory inspectors and their audiences', 'Leonard Horner wrote for Parliament, not workers…']]] });
    grade(histSource, maya, 24, 'Sharp reading of audience and purpose. Push further on what the reports leave out — whose voices are missing?', { grader: chen, daysAgo: 4 });
    for (const s of [maya, priya, tom]) {
      submit(histEssay1, { student: s, by: s, daysAgo: 7, files: [[`essay1_${s === maya ? 'okafor' : s === priya ? 'natarajan' : 'lindqvist'}.pdf`, ['Essay 1: Fiscal crisis and the French Revolution', 'Thesis: fiscal crisis was necessary but not sufficient…']]] });
    }
    // Graded but not yet released: the student must not see this score.
    grade(histEssay1, maya, 81, 'Well-structured argument. Draft feedback — to be released with the rest of the class.', { released: 0, grader: chen, daysAgo: 1 });

    // STAT 201
    submit(statHw5, { student: maya, by: maya, daysAgo: 4, late: 1, files: [['hw5_okafor.pdf', ['Homework 5', '6.12: mean of sample means = 50', '6.18: SE = 2.5']]] });
    grade(statHw5, maya, 42, 'Correct throughout; 5 points deducted for one day late. 6.31 needed the simulation plot.', { grader: whitfield, daysAgo: 2 });
    for (const [s, pts] of [[daniel, 47], [priya, 50], [aisha, 38]]) { submit(statHw5, { student: s, by: s, daysAgo: 6, files: [['hw5.pdf', ['Homework 5']]] }); grade(statHw5, s, pts, '', { grader: whitfield, daysAgo: 2 }); }

    // ----- A few notifications for the main demo student -----
    const n = (uid, kind, title, link, c, key, daysAgo, read = false) => db.prepare(`
      INSERT INTO notifications (user_id, kind, title, link, course_id, dedupe_key, read_at, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid, kind, title, link, c, key, read ? ago(daysAgo - 0.1) : null, ago(daysAgo, 15));
    n(maya, 'grade_released', 'Feedback available: Homework 5: Sampling distributions', `/courses/${stat}/assignments/${statHw5}#feedback`, stat, 'seed-1', 2);
    n(maya, 'announcement', 'Announcement: No lecture next Monday', `/courses/${cs}`, cs, 'seed-2', 1);
    n(maya, 'grade_released', 'Feedback available: Primary source analysis', `/courses/${hist}/assignments/${histSource}#feedback`, hist, 'seed-3', 4, true);
    n(maya, 'receipt', 'Submission received: Lab 6: Profiling', `/courses/${cs}/assignments/${csLab6}/receipt`, cs, 'seed-4', 3, true);
  });

  // Declared after use (hoisted) so the course content above reads top to bottom.
  function addResource(c, m, kind, title, description, uploader, opts) {
    const { file, url, published = 1, daysAgo = 20 } = opts;
    let stored = null;
    let size = null;
    if (file) {
      const buf = makePdf(title, file);
      stored = storage.save(buf, 'resource.pdf');
      size = buf.length;
    }
    const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM resources WHERE module_id = ?').get(m).p;
    const when = DateTime.now().minus({ days: daysAgo }).toUTC().toISO();
    db.prepare(`INSERT INTO resources (course_id, module_id, title, description, kind, url, file_name, stored_name, file_size, position, published, uploader_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c, m, title, description, kind, url || null,
      file ? `${title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.pdf` : null, stored, size, position, published, uploader, when, when);
  }

  run();
  console.log(`Demo data loaded. All demo accounts use the password “${DEMO_PASSWORD}”.`);
}

if (require.main === module) seed();

module.exports = { seed, DEMO_PASSWORD };
