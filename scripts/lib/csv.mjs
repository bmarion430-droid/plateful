// Streaming CSV/TSV reader tuned for the USDA FoodData Central exports
// (every field quoted) and the Open Food Facts export (tab-separated, unquoted).
// Calls onRow(fields, header) for every data row. Returns the header.

export async function readDelimited(stream, onRow, { delimiter = ",", quoted = true } = {}) {
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let header = null;
  let stop = false;
  const emit = (fields) => {
    if (!header) { header = fields.map((h) => h.replace(/^﻿/, "").trim()); return; }
    if (onRow(fields, header) === false) stop = true;
  };
  const consume = (final) => {
    let pos = 0;
    const n = buf.length;
    while (pos < n && !stop) {
      let nl = buf.indexOf("\n", pos);
      if (nl === -1) {
        if (!final) break;
        nl = n;
      }
      let line = buf.slice(pos, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!quoted) {
        if (line.length) emit(line.split(delimiter));
        pos = nl + 1;
        continue;
      }
      // Fast paths: no quotes at all, or every field simply quoted.
      if (line.indexOf('"') === -1) {
        if (line.length) emit(line.split(delimiter));
        pos = nl + 1;
        continue;
      }
      if (line.length > 1 && line[0] === '"' && line[line.length - 1] === '"' && line.indexOf('""') === -1) {
        const f = line.slice(1, -1).split('"' + delimiter + '"');
        if (!header || f.length === header.length) {
          emit(f);
          pos = nl + 1;
          continue;
        }
      }
      // General quote-aware parse (handles "" escapes and newlines inside quotes).
      const r = parseRecord(buf, pos, delimiter, final);
      if (!r) break; // record continues in the next chunk
      if (r.fields.length > 1 || r.fields[0] !== "") emit(r.fields);
      pos = r.next;
    }
    buf = buf.slice(pos);
  };
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    consume(false);
    if (stop) break;
  }
  if (!stop) {
    buf += dec.decode();
    consume(true);
  }
  if (typeof stream.destroy === "function" && stop) stream.destroy();
  return header;
}

function parseRecord(s, pos, d, final) {
  const fields = [];
  let field = "";
  let i = pos;
  const n = s.length;
  let inQ = false;
  while (i < n) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (i + 1 >= n && !final) return null;
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === d) { fields.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      fields.push(field);
      if (c === "\r" && s[i + 1] === "\n") i++;
      return { fields, next: i + 1 };
    }
    field += c; i++;
  }
  if (!final) return null;
  fields.push(field);
  return { fields, next: n };
}

// Map header names to indexes; throws a readable error if a required column is missing.
export function columns(header, names, file) {
  const idx = {};
  for (const name of names) {
    const optional = name.endsWith("?");
    const key = optional ? name.slice(0, -1) : name;
    const i = header.indexOf(key);
    if (i === -1 && !optional) throw new Error(`${file}: expected column "${key}" not found. Columns: ${header.slice(0, 30).join(", ")}`);
    idx[key] = i;
  }
  return idx;
}
