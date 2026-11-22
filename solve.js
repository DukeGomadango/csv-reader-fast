// A faster drop-in for csv-reader 1.0.0: run({text, header}) returns {columns, rows, errors}, the same answer as the reference.
// runBuffer(input) returns that answer as JSON text in a Buffer (UTF-8); run() is just JSON.parse of it.
//
// Fast road: the text is handled as its UTF-8 bytes (one latin1 char per byte; every CSV delimiter is ASCII, so the reading
// does not change). A run of clean records is turned into JSON rows by one sticky global regexp replace over a small window,
// with no per-field JavaScript: unquoted fields get quotes, quoted fields keep their bodies, a doubled quote inside quotes
// becomes \" and a line break inside quotes becomes \n afterwards. Anything unusual (a record of another width, a stray CR,
// characters after a closing quote, a quote that never closes, ...) is read by the careful one-record-at-a-time road below,
// which is csv-reader's own algorithm. A text holding a backslash, a control character other than CR/LF, a lone surrogate,
// or the two characters "]," is read entirely on the careful road.

const UNSAFE = /[\\\x00-\x09\x0b\x0c\x0e-\x1f]/;
// A doubled quote "" whose left neighbour is not a comma or LF and whose right neighbour is not a comma, CR or LF cannot hold a
// field delimiter, so it is an escaped quote inside a quoted field: U+0002 U+0002 replace it (same length, so positions stay).
const INNER_QUOTE = /""(?<=[^,\n]"")(?![,\r\n]|$)/g;
const RE_BREAK = /\r\n?|\n/g;
const RE_END = /\],/g;
const WINDOW = 4096;

function count(s, re) {
  const m = s.match(re);
  return m === null ? 0 : m.length;
}

// With isBytes true, input.text holds the UTF-8 bytes of the text, one char each (cases.json read as latin1).
export function runBuffer(input, isBytes) {
  let text = String(input.text);
  const header = input.header === true;
  let fast;
  if (isBytes === true) {
    // A U+FEFF (EF BB BF) at the very start is dropped.
    if (text.charCodeAt(0) === 0xef && text.charCodeAt(1) === 0xbb && text.charCodeAt(2) === 0xbf) text = text.slice(3);
    fast = text.length > 0 && !UNSAFE.test(text) && !text.includes('],');
    if (!fast) {
      // Back to the real string, every record on the careful road.
      text = Buffer.from(String(input.text), 'latin1').toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
  } else {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const original = text;
    fast = text.length > 0 && text.isWellFormed();
    if (fast) {
      const b = Buffer.from(text, 'utf8');
      text = b.latin1Slice(0, b.length);
      fast = !UNSAFE.test(text) && !text.includes('],');
      if (!fast) text = original;
    }
  }
  const n = text.length;
  const errors = [];
  let columns = null;
  let width = -1;
  let nrows = 0;

  // Each row of the output is JSON followed by a comma (the last comma is cut at the end).
  const parts = [];
  const text2 = fast ? text.replace(INNER_QUOTE, '\x02\x02') : '';
  const hasInner = fast && text2 !== text;
  let hasBreak = false;
  let grep = null;
  let tmpl = '';

  let pos = 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  // How the last field ended: 0 at a comma, 1 at a line break, 2 at the end of the text; and the characters kept after a closing quote.
  let ended = 0;
  let added = 0;

  // The next comma, LF and CR at or after the scan position (n when none). The scan only moves forward, so they are remembered.
  let nc = -1;
  let nl = -1;
  let nr = -1;

  // Reads unquoted characters from pos up to the next comma or line break, onto prefix; a CR not followed by LF is dropped.
  function unquoted(prefix) {
    let v = prefix;
    let start = pos;
    let kept = 0;
    for (;;) {
      if (nc < start) {
        nc = text.indexOf(',', start);
        if (nc < 0) nc = n;
      }
      if (nl < start) {
        nl = text.indexOf('\n', start);
        if (nl < 0) nl = n;
      }
      if (nr < start) {
        nr = text.indexOf('\r', start);
        if (nr < 0) nr = n;
      }
      const i = nc < nl ? (nc < nr ? nc : nr) : nl < nr ? nl : nr;
      if (i >= n) {
        v += text.slice(start, n);
        added = kept + n - start;
        pos = n;
        ended = 2;
        return v;
      }
      if (i === nc) {
        v += text.slice(start, i);
        added = kept + i - start;
        pos = i + 1;
        ended = 0;
        return v;
      }
      if (i === nl) {
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
    if (nl < open + 1) {
      nl = text.indexOf('\n', open + 1);
      if (nl < 0) nl = n;
    }
    if (nr < open + 1) {
      nr = text.indexOf('\r', open + 1);
      if (nr < 0) nr = n;
    }
    if (nl < q || nr < q) {
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
    }
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

  // The clean-record regexp for records of w fields. A field is quoted (no quote and no lone U+0002 inside, U+0002 in pairs;
  // group 1 is the body) or unquoted (no quote, comma, CR, LF or U+0002; group 2). The record ends at LF or CRLF.
  function prepare(w) {
    const q = '"([^"\\x02]*(?:\\x02\\x02[^"\\x02]*)*)"';
    const u = '([^",\\r\\n\\x02]*)';
    const f = '(?:' + q + '|' + u + ')';
    grep = new RegExp(Array(w).fill(f).join(',') + '\\r?\\n', 'gy');
    let t = '[';
    for (let i = 0; i < w; i++) t += (i ? ',' : '') + '"$' + (2 * i + 1) + '$' + (2 * i + 2) + '"';
    tmpl = t + '],';
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

    if (grep !== null) {
      // The sticky global replace turns the clean records at pos into JSON rows and stops at the first record that is not clean
      // (or cut by the window's end), leaving the rest of the window as it was. The text holds no "]," so the last "]," of the
      // result is the end of the last row.
      const w = text2.slice(pos, pos + WINDOW);
      const out = w.replace(grep, tmpl);
      const last = out.lastIndexOf('],');
      if (last >= 0) {
        const done = out.slice(0, last + 2);
        parts.push(done);
        const k = count(done, RE_END);
        nrows += k;
        pos += w.length - (out.length - last - 2);
        // Only line breaks inside quotes are left in the rows; each is a line.
        if (done.indexOf('\n') >= 0 || done.indexOf('\r') >= 0) {
          hasBreak = true;
          line += k + count(done, RE_BREAK);
        } else line += k;
        continue;
      }
    }

    recordLine = line;
    recordRow = header && columns === null ? null : nrows;
    const fields = [];
    let isQuoted;
    do {
      isQuoted = text.charCodeAt(pos) === 34;
      fields.push(isQuoted ? quoted() : unquoted(''));
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !isQuoted) continue;

    if (width < 0) {
      width = fields.length;
      if (fast && width >= 2 && width <= 40) prepare(width);
    }
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
    parts.push(JSON.stringify(fields) + ',');
    nrows++;
  }

  let rows = parts.join('');
  if (fast) {
    // Inside quotes: an escaped quote is \" and a line break (CRLF, CR or LF) is \n.
    if (hasInner) rows = rows.replaceAll('\x02\x02', '\\"');
    if (hasBreak) rows = rows.replace(RE_BREAK, '\\n');
  }
  if (rows.length > 0) rows = rows.slice(0, -1);
  const json = '{"columns":' + (header ? JSON.stringify(columns ?? []) : 'null') + ',"rows":[' + rows + '],"errors":' + JSON.stringify(errors) + '}';
  return Buffer.from(json, fast ? 'latin1' : 'utf8');
}

export function run(input) {
  return JSON.parse(runBuffer(input, false).toString('utf8'));
}
