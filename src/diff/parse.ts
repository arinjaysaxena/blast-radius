// Small signature parsers for the string-based structural diff.

export interface ParsedParam {
  name: string;
  optional: boolean;
  rest: boolean;
  type: string;
}

export interface ParsedCall {
  generics: string;
  params: ParsedParam[];
  ret: string;
}

export interface ParsedShape {
  ctor: string;
  members: Map<string, { optional: boolean; type: string }>;
}

const OPENERS = '([{<';
const CLOSERS = ')]}';

function closesDepth(text: string, i: number): boolean {
  const ch = text.charAt(i);
  return CLOSERS.includes(ch) || (ch === '>' && text[i - 1] !== '=');
}

/** Split `text` on `sep` at bracket depth 0 (handles (), [], {}, <> and ignores `=>`). */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (OPENERS.includes(ch)) depth++;
    else if (closesDepth(text, i)) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Split a function signature string into overloads: "(a): x | (b): y" -> ["(a): x", "(b): y"]. */
export function splitOverloads(sig: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig.charAt(i);
    if (OPENERS.includes(ch)) depth++;
    else if (closesDepth(sig, i)) depth = Math.max(0, depth - 1);
    if (depth === 0 && sig.startsWith(' | ', i) && /^[<(]/.test(sig.slice(i + 3))) {
      out.push(sig.slice(start, i).trim());
      start = i + 3;
    }
  }
  out.push(sig.slice(start).trim());
  return out;
}

/** Parse "<T>(a: A, b?: B): R" into generics, parameters and return type. */
export function parseCallSignature(sig: string): ParsedCall | null {
  const open = sig.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const params = splitTopLevel(sig.slice(open + 1, close), ',').map((p): ParsedParam => {
    const m = /^(\.\.\.)?([\w$]+)(\?)?\s*:\s*([\s\S]*)$/.exec(p);
    if (!m) return { rest: false, name: p, optional: false, type: p };
    return { rest: Boolean(m[1]), name: m[2] ?? p, optional: Boolean(m[3]) || Boolean(m[1]), type: (m[4] ?? '').trim() };
  });
  return { generics: sig.slice(0, open).trim(), params, ret: sig.slice(close + 1).replace(/^\s*:\s*/, '').trim() };
}

/** Parse the `{ a: T; b?: U }` body of an object-like signature (ignoring any `new (...)` prefix). */
export function parseMembers(sig: string): ParsedShape | null {
  const start = sig.indexOf('{');
  const end = sig.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const members = new Map<string, { optional: boolean; type: string }>();
  for (const m of splitTopLevel(sig.slice(start + 1, end), ';')) {
    const mm = /^((?:static )?[\w$]+)(\?)?\s*:\s*([\s\S]*)$/.exec(m);
    if (mm?.[1] !== undefined) members.set(mm[1], { optional: Boolean(mm[2]), type: (mm[3] ?? '').trim() });
  }
  return { ctor: sig.slice(0, start).trim(), members };
}
