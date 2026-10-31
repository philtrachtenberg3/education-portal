'use strict';
// Local-disk file storage behind a small interface (save/stream/remove) so it can
// be replaced with object storage later. Files are stored under random names and
// only served through permission-checked routes — never from a public directory.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../db');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Content signatures for binary formats. Text formats must not contain NUL bytes.
const SIGNATURES = {
  pdf: [Buffer.from('%PDF')],
  docx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  pptx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  xlsx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  zip: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
};
const TEXT_TYPES = new Set(['txt', 'md', 'csv', 'py', 'java', 'js', 'r', 'ipynb', 'json', 'html', 'css', 'sql']);

const extOf = (name) => path.extname(name || '').slice(1).toLowerCase();

/**
 * Validate an uploaded file held in memory. Returns an error message, or null if valid.
 * @param {{originalname:string,size:number,buffer:Buffer}} file
 * @param {string[]} allowed extensions
 * @param {number} maxBytes
 */
function validateFile(file, allowed, maxBytes) {
  const ext = extOf(file.originalname);
  if (!allowed.includes(ext)) return `“${file.originalname}” is a .${ext || '?'} file. Accepted types: ${allowed.map((e) => '.' + e).join(', ')}.`;
  if (file.size === 0) return `“${file.originalname}” is empty.`;
  if (file.size > maxBytes) return `“${file.originalname}” is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`;
  if (SIGNATURES[ext]) {
    if (!SIGNATURES[ext].some((sig) => file.buffer.subarray(0, sig.length).equals(sig))) {
      return `“${file.originalname}” does not look like a valid .${ext} file. It may be damaged or renamed.`;
    }
  } else if (TEXT_TYPES.has(ext)) {
    if (file.buffer.includes(0)) return `“${file.originalname}” does not look like a text file.`;
  } else {
    return `.${ext} files cannot be verified by the portal yet.`;
  }
  return null;
}

function save(buffer, originalName) {
  const stored = `${crypto.randomUUID()}.${extOf(originalName) || 'bin'}`;
  const full = path.join(UPLOAD_DIR, stored);
  const fd = fs.openSync(full, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd); // durable before we report success
  } finally {
    fs.closeSync(fd);
  }
  return stored;
}

function remove(stored) {
  if (!stored) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(stored)), { force: true }, () => {});
}

function send(res, stored, downloadName) {
  const full = path.join(UPLOAD_DIR, path.basename(stored));
  if (!fs.existsSync(full)) return res.status(404).send('File not found');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // Only PDFs and images open inline; everything else downloads.
  const inline = ['pdf', 'png', 'jpg', 'jpeg'].includes(extOf(stored));
  return inline ? res.sendFile(full, { headers: { 'Content-Disposition': `inline; filename="${encodeURIComponent(downloadName)}"` } })
    : res.download(full, downloadName);
}

module.exports = { validateFile, save, remove, send, extOf, UPLOAD_DIR };
