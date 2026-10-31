// Progressive enhancement only: every form works without JavaScript.
(function () {
  'use strict';

  // Move focus to an error summary so screen-reader users hear what went wrong.
  const summary = document.querySelector('.error-summary');
  if (summary) summary.focus();

  // Keep the clicked button's name/value, then disable buttons to prevent double submits.
  function lockForm(form, submitter) {
    if (submitter && submitter.name) {
      const h = document.createElement('input');
      h.type = 'hidden';
      h.name = submitter.name;
      h.value = submitter.value;
      form.appendChild(h);
    }
    form.querySelectorAll('button[type=submit], button:not([type])').forEach((b) => { b.disabled = true; });
  }
  function unlockForm(form) {
    form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }

  // ---------- Unsaved-changes warning on editing forms ----------
  let dirty = false;
  document.querySelectorAll('form[data-warn-unsaved]').forEach((form) => {
    form.addEventListener('input', () => { dirty = true; });
    form.addEventListener('change', () => { dirty = true; });
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || form.hasAttribute('data-submission-form')) return; // handled elsewhere
    const msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    dirty = false;
    lockForm(form, e.submitter);
  });

  // ---------- Dashboard "Upcoming" filters: update the card in place ----------
  // Fetches the filtered dashboard and swaps only this card, so the page doesn't
  // reload or scroll. Focus returns to the control that was used.
  const dueCard = document.getElementById('due-card');
  const dueLive = document.getElementById('due-live');
  if (dueCard) {
    let pending = null;
    const loadDue = async (url, focusKey) => {
      if (pending) pending.abort();
      pending = new AbortController();
      dueCard.setAttribute('aria-busy', 'true');
      try {
        const r = await fetch(url, { headers: { Accept: 'text/html' }, signal: pending.signal });
        const fresh = r.ok && new DOMParser().parseFromString(await r.text(), 'text/html').getElementById('due-card');
        if (!fresh) throw new Error('unexpected response');
        dueCard.innerHTML = fresh.innerHTML;
        history.replaceState(null, '', url);
        const target = focusKey && dueCard.querySelector('[data-key="' + focusKey + '"]');
        if (target) target.focus();
        const summary = dueCard.querySelector('.due-summary');
        if (dueLive && summary) dueLive.textContent = summary.textContent;
      } catch (err) {
        if (err.name !== 'AbortError') window.location.assign(url); // fall back to a normal page load
      } finally {
        dueCard.removeAttribute('aria-busy');
      }
    };
    dueCard.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-due-link]');
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      loadDue(a.href, a.dataset.key);
    });
    dueCard.addEventListener('submit', (e) => {
      const f = e.target.closest('form[data-due-form]');
      if (!f) return;
      e.preventDefault();
      loadDue(f.action + '?' + new URLSearchParams(new FormData(f)).toString(), f.dataset.key);
    });
  }

  // ---------- Assignment submission: client checks, confirmation, progress ----------
  const form = document.querySelector('form[data-submission-form]');
  if (!form) return;
  const fileInput = form.querySelector('input[type=file]');
  const live = document.getElementById('submit-status');
  const dialog = document.getElementById('confirm-dialog');
  const progressWrap = form.querySelector('.progress');
  const progress = progressWrap && progressWrap.querySelector('progress');
  const allowed = (form.dataset.allowed || '').split(',').filter(Boolean);
  const maxBytes = Number(form.dataset.maxMb || 0) * 1048576;

  function say(text, kind) {
    live.className = 'notice ' + (kind || '');
    live.hidden = !text;
    live.textContent = text;
  }

  function clientErrors() {
    const errs = [];
    const files = fileInput ? Array.from(fileInput.files) : [];
    files.forEach((f) => {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (allowed.length && allowed.indexOf(ext) === -1) errs.push('“' + f.name + '” is not an accepted file type (' + allowed.map((x) => '.' + x).join(', ') + ').');
      if (maxBytes && f.size > maxBytes) errs.push('“' + f.name + '” is larger than the ' + form.dataset.maxMb + ' MB limit.');
    });
    const text = form.querySelector('[name=body_text]');
    const link = form.querySelector('[name=link_url]');
    if (!files.length && !(text && text.value.trim()) && !(link && link.value.trim())) errs.push('Add your work before submitting.');
    const confirmBox = form.querySelector('[name=confirm]');
    if (confirmBox && !confirmBox.checked) errs.push('Tick the confirmation box.');
    return errs;
  }

  function summaryItems() {
    const out = [];
    if (fileInput) Array.from(fileInput.files).forEach((f) => out.push('File: ' + f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)'));
    const text = form.querySelector('[name=body_text]');
    if (text && text.value.trim()) out.push('Text response: ' + text.value.trim().split(/\s+/).length + ' words');
    const link = form.querySelector('[name=link_url]');
    if (link && link.value.trim()) out.push('Link: ' + link.value.trim());
    return out;
  }

  function send() {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('Accept', 'text/html');
    if (progressWrap) progressWrap.hidden = false;
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable && progress) {
        progress.value = Math.round((ev.loaded / ev.total) * 100);
        progress.textContent = progress.value + '%';
      }
    });
    xhr.addEventListener('load', () => {
      const landed = xhr.responseURL && new URL(xhr.responseURL).pathname !== new URL(form.action, location.href).pathname;
      if (landed && xhr.status < 400) { window.location.assign(xhr.responseURL); return; }
      // The server re-rendered the form with errors: show that page.
      document.open(); document.write(xhr.responseText); document.close();
    });
    xhr.addEventListener('error', () => {
      if (progressWrap) progressWrap.hidden = true;
      unlockForm(form);
      say('Upload failed: the connection was interrupted. Nothing was submitted. Your files and text are still here — try again.', 'bad');
    });
    lockForm(form, null);
    say('Uploading… do not close this page.', '');
    xhr.send(new FormData(form));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const errs = clientErrors();
    if (errs.length) { say(errs.join(' '), 'bad'); live.focus(); return; }
    if (dialog && typeof dialog.showModal === 'function') {
      const list = dialog.querySelector('[data-summary]');
      list.innerHTML = '';
      summaryItems().forEach((t) => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
      dialog.showModal();
    } else {
      send();
    }
  });

  if (dialog) {
    dialog.querySelector('[data-confirm-submit]').addEventListener('click', () => { dialog.close(); send(); });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  }
})();
