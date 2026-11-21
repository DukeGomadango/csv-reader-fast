// A faster drop-in for csv-reader 1.0.0: run({text, header}) returns {columns, rows, errors}.
// One left-to-right pass over charCodes; fields are slices of the text rather than strings built a character at a time.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  // How the last field ended: 0 at a comma, 1 at a line break, 2 at the end of the text; and the characters kept after a closing quote.
  let ended = 0;
  let added = 0;

  // Reads unquoted characters from pos up to the next comma or line break, onto prefix; a CR not followed by LF is dropped.
  function unquoted(prefix) {
    let v = prefix;
    let start = pos;
    let kept = 0;
    for (let i = pos; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c > 44 || (c !== 44 && c !== 10 && c !== 13)) continue;
      if (c === 44) {
        v += text.slice(start, i);
        added = kept + i - start;
        pos = i + 1;
        ended = 0;
        return v;
      }
      if (c === 10) {
        v += text.slice(start, i);
        added = kept + i - start;
        pos = i + 1;
        line++;
        ended = 1;
        return v;
      }
      if (text.charCodeAt(i + 1) === 10) {
        v += text.slice(start, i);
        added = kept + i - start;
        pos = i + 2;
        line++;
        ended = 1;
        return v;
      }
      v += text.slice(start, i);
      kept += i - start;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      start = i + 1;
    }
    v += text.slice(start, n);
    added = kept + n - start;
    pos = n;
    ended = 2;
    return v;
  }

  // Reads a quoted field whose opening quote is at pos.
  function quoted() {
    const open = pos;
    let i = open + 1;
    let esc = false;
    let q;
    for (;;) {
      q = text.indexOf('"', i);
      if (q < 0) {
        // Never closes: the quote is a literal character and the rest is read again as unquoted.
        pos = open + 1;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        esc = true;
        i = q + 2;
        continue;
      }
      break;
    }
    let value = text.slice(open + 1, q);
    if (esc) value = value.replaceAll('""', '"');
    // Line breaks inside the quotes: CRLF and a lone CR each read as one LF, and every break counts as a line.
    let hasCR = false;
    for (let k = open + 1; k < q; k++) {
      const c = text.charCodeAt(k);
      if (c === 10) line++;
      else if (c === 13) {
        hasCR = true;
        line++;
        if (text.charCodeAt(k + 1) === 10) k++;
      }
    }
    if (hasCR) value = value.replace(/\r\n?/g, '\n');
    pos = q + 1;
    if (pos >= n) {
      ended = 2;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      ended = 0;
      return value;
    }
    if (c === 10) {
      pos++;
      line++;
      ended = 1;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      ended = 1;
      return value;
    }
    const v = unquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return v;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let isQuoted;
    do {
      isQuoted = text.charCodeAt(pos) === 34;
      fields.push(isQuoted ? quoted() : unquoted(''));
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !isQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const len = fields.length;
    if (len < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: len });
      while (fields.length < width) fields.push('');
    } else if (len > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
