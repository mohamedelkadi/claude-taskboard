'use strict';
// The Markdown shown in descriptions and notes: headings, lists (nested, numbered, tasks),
// quotes, code, tables, links and the card's own attachments. Whatever was typed is escaped
// before any tag is added. Images only ever load from the board itself: a picture on another
// site stays a link, so that reading a note never calls out to that site.
(function () {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const e = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const MAX_DEPTH = 8; // quotes and lists nested deeper than this read as plain text

  const indentOf = (line) => /^\s*/.exec(line)[0].length;
  const link = (url, label) => `<a href="${e(url)}" target="_blank" rel="noopener">${e(label)}</a>`;

  function attachment(id, label, isImage, files) {
    const file = files && files(id);
    if (!file) return `<span class="md-gone" title="This attachment was removed from the card">${e(label || 'Attachment')} (removed)</span>`;
    const name = label || file.name;
    if (isImage && file.image) {
      return `<button type="button" class="md-img" data-act="att-view" data-att="${e(id)}" title="${e(file.name)}"><img src="${e(file.url)}" alt="${e(name)}" loading="lazy"></button>`;
    }
    return `<a class="md-file" href="${e(file.url)}" download="${e(file.name)}">${e(name)}</a>`;
  }

  function inline(text, files) {
    // Finished pieces wait behind a marker, so nothing formats the inside of code or a link.
    const held = [];
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    const rest = String(text)
      .replace(/\u0000/g, '')
      .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${e(code)}</code>`))
      .replace(/(!?)\[([^\]\n]*)\]\(attachment:(a_[0-9a-f]{8})\)/g, (_, bang, label, id) => hold(attachment(id, label, !!bang, files)))
      .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => hold(link(url, label)))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)([.,;:!?]*)(?=[\s)]|$)/g, (_, before, url, after) => `${before}${hold(link(url, url))}${after}`);
    return e(rest)
      .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)__(\S(?:.*?\S)?)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/~~(\S(?:.*?\S)?)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|\W)_(\S(?:[^_]*?\S)?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
  }

  const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_RULE.test(lines[i + 1]);
  const opensBlock = (lines, i) => {
    const l = lines[i];
    return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST.test(l) || isTable(lines, i);
  };
  const closesFence = (line, fence) => {
    const t = line.trim();
    return t.length >= fence.length && t[0] === fence[0] && t === t[0].repeat(t.length);
  };

  function table(lines, start, files) {
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').replace(/\\\|/g, '\u0001').split('|').map((c) => c.trim().replace(/\u0001/g, '|'));
    const head = cells(lines[start]);
    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
    const html = `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, files)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] || '', files)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
    return [html, i];
  }

  function list(lines, start, files, depth) {
    const first = LIST.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameList = (m) => m && m[1].length === indent && /\d/.test(m[2]) === ordered;
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = LIST.exec(lines[i]);
      if (!sameList(m) || RULE.test(lines[i])) break;
      const cut = indent + m[2].length + 1;
      const inner = [];
      i++;
      // whatever is indented under this item belongs to it, blank lines included
      while (i < lines.length) {
        if (!lines[i].trim()) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j >= lines.length || indentOf(lines[j]) <= indent) break;
          inner.push('');
          i++;
        } else if (indentOf(lines[i]) <= indent) break;
        else {
          inner.push(lines[i].slice(Math.min(indentOf(lines[i]), cut)));
          i++;
        }
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      const body = inline(task ? task[2] : m[3], files) + (inner.some((l) => l.trim()) ? blocks(inner, files, depth + 1) : '');
      if (task) {
        const done = task[1] !== ' ';
        items.push(`<li class="md-task${done ? ' done' : ''}"><span class="md-box" role="img" aria-label="${done ? 'Done' : 'Not done'}">${done ? '✓' : ''}</span><div>${body}</div></li>`);
      } else items.push(`<li>${body}</li>`);
      // a blank line between two items does not end the list, or numbering would restart
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j > i) {
        if (j < lines.length && sameList(LIST.exec(lines[j]))) i = j;
        else break;
      }
    }
    const number = parseInt(first[2], 10);
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}${ordered && number !== 1 ? ` start="${number}"` : ''}>${items.join('')}</${tag}>`, i];
  }

  function blocks(lines, files, depth) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !closesFence(lines[i], fence[1])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${e(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length, 4);
        out.push(`<div class="md-h md-h${level}" role="heading" aria-level="${Math.min(level + 4, 6)}">${inline(heading[2], files)}</div>`);
        i++;
        continue;
      }
      if (RULE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (QUOTE.test(line) && depth < MAX_DEPTH) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ''));
        out.push(`<blockquote>${blocks(inner, files, depth + 1)}</blockquote>`);
        continue;
      }
      if (isTable(lines, i)) {
        const [html, next] = table(lines, i, files);
        out.push(html);
        i = next;
        continue;
      }
      if (LIST.test(line) && depth < MAX_DEPTH) {
        const [html, next] = list(lines, i, files, depth);
        out.push(html);
        i = next;
        continue;
      }
      const para = [];
      do para.push(inline(lines[i++].trim(), files));
      while (i < lines.length && lines[i].trim() && !opensBlock(lines, i));
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** `opts.attachment(id)` says what an `attachment:` link points at: { name, url, image }. */
  function md(text, opts) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    return blocks(lines, opts && opts.attachment, 0);
  }

  if (typeof module === 'object' && module.exports) module.exports = { md };
  else window.md = md;
})();
