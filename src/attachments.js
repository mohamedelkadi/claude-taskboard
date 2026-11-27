'use strict';
// Files kept on a card. The bytes live in their own folder under a name made here, never one
// from the upload. A file is an image only if its first bytes say so: images are the one kind
// the board shows, and everything else is served as a download, because a page or script
// shown from this origin could read the user's private session history.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_BYTES = 25 * 1024 * 1024;

const starts = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const IMAGES = [
  { type: 'image/png', ext: '.png', is: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'image/jpeg', ext: '.jpg', is: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { type: 'image/gif', ext: '.gif', is: (b) => starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a')) },
  { type: 'image/webp', ext: '.webp', is: (b) => starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8) },
];

function fileName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return base.slice(-120) || 'file';
}

/** Keep a file and put it on the card. Returns the attachment. */
function add(cardRef, rawName, data, by) {
  if (!data.length) throw new store.UserError('That file is empty.');
  if (data.length > MAX_BYTES) throw new store.UserError('Files can be up to 25 MB.');
  const name = fileName(rawName);
  const image = IMAGES.find((t) => t.is(data));
  const ext = image ? image.ext : (/\.[a-z0-9]{1,10}$/i.exec(name) || [''])[0].toLowerCase();
  const att = { id: 'a_' + crypto.randomBytes(4).toString('hex'), name, type: image ? image.type : '', ext, size: data.length, at: Date.now(), by: by || 'me' };
  const file = store.attachmentFile(att);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  try {
    return store.addAttachment(cardRef, att);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

function find(cards, id) {
  for (const card of cards) {
    const hit = (card.attachments || []).find((f) => f.id === id);
    if (hit) return hit;
  }
  return null;
}

/** A file never changes, but it can be deleted: the browser asks each time before reusing its copy. */
const cacheHeaders = (att) => ({ 'cache-control': 'private, no-cache', etag: `"${att.id}"` });

/** The headers a file is served with. Only a checked image is ever shown in the page. */
function headers(att) {
  const shown = IMAGES.some((t) => t.type === att.type);
  return {
    'content-type': shown ? att.type : 'application/octet-stream',
    'content-length': att.size,
    'content-disposition': `${shown ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    ...cacheHeaders(att),
  };
}

module.exports = { MAX_BYTES, add, find, headers, cacheHeaders, fileName };
