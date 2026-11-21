// Slice-scanning drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// input {text, header}: {columns, rows, errors}. It is faster because it
// never builds a field one character at a time: an unquoted field is taken
// with one slice() at its delimiter, and a quoted field jumps from quote
// to quote with indexOf() instead of walking each character. Only the rare
// broken pieces (a stray CR, a doubled quote, a line break inside quotes)
// take a slower path.
//
// Pure JavaScript, no dependencies, no WebAssembly, no native code, nothing
// kept from one call to the next.

// How a field ended: at a comma, at a line break, or at the end of the text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const t = String(input.text);
  const header = input.header === true;
  const n = t.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (t.charCodeAt(0) === 0xfeff) pos = 1; // a U+FEFF at the very start is dropped

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these two.
  let recordLine = 1;
  let recordRow = null;

  // What the field just scanned holds, how it ended, and how many characters
  // were kept after its opening (for the quote_junk check).
  let fVal = '';
  let fEnded = END;
  let fAdded = 0;

  // Counts the line breaks in t[from..to): LF, CRLF and lone CR each count
  // once, so a CRLF is one break, not two.
  function countBreaks(from, to) {
    let count = 0;
    let p = from;
    while (p < to) {
      const nl = t.indexOf('\n', p);
      const cr = t.indexOf('\r', p);
      let m = -1;
      if (nl !== -1 && nl < to && (cr === -1 || cr >= to || nl < cr)) m = nl;
      else if (cr !== -1 && cr < to) m = cr;
      else break;
      count += 1;
      p = m + 1;
      if (t.charCodeAt(m) === 13 && t.charCodeAt(m + 1) === 10) p = m + 2;
    }
    return count;
  }

  // Reads an unquoted field starting at pos, building on `init` ('' for a
  // plain field, the quoted value when this is the junk after a closing
  // quote). Sets fVal, fEnded and fAdded. A CR not followed by LF is dropped
  // (stray_cr); the field ends at a comma, a line break, or the end of the
  // text. A quote inside it is a literal character.
  function scanUnquoted(init) {
    let value = init;
    let start = pos;
    let added = 0;
    let ended = END;
    let end = n;
    while (pos < n) {
      const c = t.charCodeAt(pos);
      if (c === 44) {
        ended = COMMA;
        end = pos;
        pos += 1;
        break;
      }
      if (c === 10) {
        ended = LINE_BREAK;
        end = pos;
        pos += 1;
        line += 1;
        break;
      }
      if (c === 13) {
        if (t.charCodeAt(pos + 1) === 10) {
          ended = LINE_BREAK;
          end = pos;
          pos += 2;
          line += 1;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        added += pos - start;
        value += t.slice(start, pos);
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    if (ended === END) end = pos;
    added += end - start;
    fVal = value === '' ? t.slice(start, end) : value + t.slice(start, end);
    fAdded = added;
    fEnded = ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = t.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && t.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = t.charCodeAt(pos) === 34;
      if (!quoted) {
        scanUnquoted('');
      } else {
        // A field that opens with a quote runs to the next quote that is not
        // doubled: "" inside it is one quote.
        const open = pos;
        let q = pos + 1;
        let segStart = q;
        let parts = null;
        let close = -1;
        while (true) {
          const qi = t.indexOf('"', q);
          if (qi === -1) break;
          if (t.charCodeAt(qi + 1) === 34) {
            if (parts === null) parts = [];
            parts.push(t.slice(segStart, qi));
            parts.push('"');
            q = qi + 2;
            segStart = qi + 2;
            continue;
          }
          close = qi;
          break;
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as an unquoted field.
          pos = open + 1;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          scanUnquoted('"');
        } else {
          let value = parts === null ? t.slice(open + 1, close) : parts.join('') + t.slice(segStart, close);
          // Each CRLF or lone CR inside the quotes is read as LF, and every
          // line break inside them moves the line count on. A field with no
          // line break inside it holds no CR at all, so the CR check is
          // skipped then.
          const breaks = countBreaks(open + 1, close);
          line += breaks;
          if (breaks > 0 && value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
          pos = close + 1;
          if (pos >= n) {
            fVal = value;
            fAdded = 0;
            fEnded = END;
          } else {
            const c = t.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fVal = value;
              fAdded = 0;
              fEnded = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fVal = value;
              fAdded = 0;
              fEnded = LINE_BREAK;
            } else if (c === 13 && t.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fVal = value;
              fAdded = 0;
              fEnded = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              scanUnquoted(value);
              if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      }
      fields.push(fVal);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
