/*
 * 8086 two-pass assembler.
 * Works in the browser (global `Assembler8086`) and in Node (module.exports).
 *
 * Supported: full 8086 base instruction set (no 8087, no far jmp/call ptr16:16),
 * labels, ORG, DB/DW (strings, DUP), EQU, expressions (+ - * / parens, $, char
 * literals, hex 0x../..h, binary ..b), segment overrides (ds:[..]),
 * BYTE/WORD PTR size overrides, REP/REPE/REPNE/LOCK prefixes.
 */
(function (global) {
'use strict';

const REG8  = { AL:0, CL:1, DL:2, BL:3, AH:4, CH:5, DH:6, BH:7 };
const REG16 = { AX:0, CX:1, DX:2, BX:3, SP:4, BP:5, SI:6, DI:7 };
const SREG  = { ES:0, CS:1, SS:2, DS:3 };
const SEG_PREFIX = { ES:0x26, CS:0x2E, SS:0x36, DS:0x3E };

// rm field for [base+index] combinations, keyed as "base,index"
const RM_TABLE = {
  'BX,SI':0, 'BX,DI':1, 'BP,SI':2, 'BP,DI':3,
  ',SI':4, ',DI':5, 'BP,':6, 'BX,':7,
};

class AsmError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

/* ---------------------------------------------------------------- numbers */

function parseNumber(tok) {
  // returns value or null if not a number token
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok.slice(2), 16);
  if (/^[0-9][0-9a-f]*h$/i.test(tok)) return parseInt(tok.slice(0, -1), 16);
  if (/^[01]+b$/i.test(tok)) return parseInt(tok.slice(0, -1), 2);
  if (/^[0-9]+$/.test(tok)) return parseInt(tok, 10);
  if (/^'.'$/.test(tok) || /^".."?$/.test(tok)) return null; // handled by lexer
  return null;
}

const IDENT_RE = /^[A-Za-z_.@?][A-Za-z0-9_.@?]*$/;

/* ------------------------------------------------------------ expressions */
// Lexer + recursive-descent parser. Result: { value, isConst }
//   value   — number, or undefined when a forward reference exists (pass 1)
//   isConst — true when the expression involves only literals and EQU
//             constants (never code labels or $); used to make encoding-size
//             decisions that must be identical in both passes.

function lexExpr(s, line) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      if (end < 0) throw new AsmError('unterminated character literal', line);
      const body = s.slice(i + 1, end);
      if (body.length !== 1) throw new AsmError(`character literal must be a single character: ${s.slice(i, end + 1)}`, line);
      toks.push({ t:'num', v: body.charCodeAt(0) });
      i = end + 1; continue;
    }
    if ('+-*/()'.includes(c)) { toks.push({ t:c }); i++; continue; }
    if (c === '$') { toks.push({ t:'$' }); i++; continue; }
    const m = s.slice(i).match(/^[A-Za-z0-9_.@?]+/);
    if (!m) throw new AsmError(`unexpected character '${c}' in expression`, line);
    const word = m[0];
    const n = parseNumber(word);
    if (n !== null) toks.push({ t:'num', v:n });
    else if (IDENT_RE.test(word)) toks.push({ t:'ident', v:word });
    else throw new AsmError(`bad token '${word}' in expression`, line);
    i += word.length;
  }
  return toks;
}

function evalExpr(s, ctx) {
  const toks = lexExpr(s, ctx.line);
  if (!toks.length) throw new AsmError('empty expression', ctx.line);
  let p = 0;
  let isConst = true;
  let undef = false;

  function factor() {
    const tk = toks[p];
    if (!tk) throw new AsmError(`unexpected end of expression: ${s}`, ctx.line);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '-') { p++; return -factor(); }
    if (tk.t === '+') { p++; return factor(); }
    if (tk.t === '(') {
      p++;
      const v = expr();
      if (!toks[p] || toks[p].t !== ')') throw new AsmError(`missing ')' in expression: ${s}`, ctx.line);
      p++; return v;
    }
    if (tk.t === '$') { p++; isConst = false; return ctx.addr; }
    if (tk.t === 'ident') {
      p++;
      const sym = ctx.symbols.get(tk.v.toUpperCase());
      if (!sym) {
        if (ctx.pass === 1) { undef = true; isConst = false; return 0; }
        throw new AsmError(`undefined symbol '${tk.v}'`, ctx.line);
      }
      if (!sym.isConst) isConst = false;
      return sym.value;
    }
    throw new AsmError(`unexpected '${tk.t}' in expression: ${s}`, ctx.line);
  }
  function term() {
    let v = factor();
    while (toks[p] && (toks[p].t === '*' || toks[p].t === '/')) {
      const op = toks[p].t; p++;
      const r = factor();
      if (op === '*') v *= r;
      else {
        if (r === 0 && !undef) throw new AsmError('division by zero', ctx.line);
        v = Math.trunc(v / (r || 1));
      }
    }
    return v;
  }
  function expr() {
    let v = term();
    while (toks[p] && (toks[p].t === '+' || toks[p].t === '-')) {
      const op = toks[p].t; p++;
      v = op === '+' ? v + term() : v - term();
    }
    return v;
  }

  const v = expr();
  if (p !== toks.length) throw new AsmError(`trailing junk in expression: ${s}`, ctx.line);
  return { value: undef ? undefined : v, isConst };
}

/* --------------------------------------------------------------- operands */
// Operand kinds:
//  { kind:'r8'|'r16', code }            register
//  { kind:'sreg', code }                segment register
//  { kind:'mem', rm, base, index, dispExpr, seg, size }  memory reference
//  { kind:'imm', expr, size, short }    immediate / label expression

function parseOperand(raw, line) {
  let s = raw.trim();
  if (!s) throw new AsmError('empty operand', line);
  let size = null;
  let short = false;

  let m = s.match(/^(byte|word)(\s+ptr)?\s+/i);
  if (m) { size = m[1].toLowerCase() === 'byte' ? 1 : 2; s = s.slice(m[0].length).trim(); }
  m = s.match(/^short\s+/i);
  if (m) { short = true; s = s.slice(m[0].length).trim(); }

  let seg = null;
  m = s.match(/^(es|cs|ss|ds)\s*:/i);
  if (m) { seg = m[1].toUpperCase(); s = s.slice(m[0].length).trim(); }

  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new AsmError(`missing ']' in operand: ${raw.trim()}`, line);
    return parseMem(s.slice(1, -1), seg, size, line, raw.trim());
  }
  if (seg) throw new AsmError(`segment override must precede a memory operand: ${raw.trim()}`, line);

  const up = s.toUpperCase();
  if (up in REG8)  return sized({ kind:'r8',  code:REG8[up],  name:up }, size, 1, line);
  if (up in REG16) return sized({ kind:'r16', code:REG16[up], name:up }, size, 2, line);
  if (up in SREG)  return sized({ kind:'sreg', code:SREG[up], name:up }, size, 2, line);

  return { kind:'imm', expr:s, size, short };
}

function sized(op, size, natural, line) {
  if (size !== null && size !== natural)
    throw new AsmError(`size override conflicts with register ${op.name}`, line);
  return op;
}

function parseMem(inner, seg, size, line, raw) {
  // split on top-level + and -
  const terms = [];
  let depth = 0, cur = '', sign = '+';
  for (const c of inner) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && (c === '+' || c === '-')) {
      if (cur.trim()) { terms.push({ sign, text: cur.trim() }); cur = ''; sign = c; }
      else if (!cur.trim() && terms.length === 0 && c === '-') { cur += c; } // leading minus → part of expr
      else { terms.push({ sign, text: '0' }); sign = c; } // shouldn't happen, defensive
      continue;
    }
    cur += c;
  }
  if (cur.trim()) terms.push({ sign, text: cur.trim() });
  if (!terms.length) throw new AsmError(`empty memory operand: ${raw}`, line);

  let base = null, index = null;
  const dispParts = [];
  for (const t of terms) {
    const up = t.text.toUpperCase();
    if (up === 'BX' || up === 'BP') {
      if (t.sign === '-') throw new AsmError(`cannot subtract register ${up} in address`, line);
      if (base) throw new AsmError(`two base registers in address: ${raw}`, line);
      base = up;
    } else if (up === 'SI' || up === 'DI') {
      if (t.sign === '-') throw new AsmError(`cannot subtract register ${up} in address`, line);
      if (index) throw new AsmError(`two index registers in address: ${raw}`, line);
      index = up;
    } else if (up in REG8 || up in REG16 || up in SREG) {
      throw new AsmError(`register ${up} is not valid in an 8086 address (only BX, BP, SI, DI)`, line);
    } else {
      dispParts.push((t.sign === '-' ? '-(' : '+(') + t.text + ')');
    }
  }
  const rm = RM_TABLE[`${base || ''},${index || ''}`];
  if (rm === undefined && (base || index))
    throw new AsmError(`invalid register combination in address: ${raw}`, line);
  const dispExpr = dispParts.length ? dispParts.join('') : null;
  if (!base && !index && !dispExpr)
    throw new AsmError(`empty memory operand: ${raw}`, line);
  return {
    kind:'mem',
    rm: (base || index) ? rm : 6,   // rm=6 with mod=0 is direct address
    direct: !base && !index,
    base, index, dispExpr, seg, size,
  };
}

/* ------------------------------------------------------------- emit utils */

function u8(bytes, v) { bytes.push(v & 0xFF); }
function u16(bytes, v) { bytes.push(v & 0xFF, (v >> 8) & 0xFF); }

function checkRange(v, bits, signedOk, what, line) {
  if (v === undefined) return;
  const lo = signedOk ? -(1 << (bits - 1)) : 0;
  const hi = (1 << bits) - 1;
  if (v < lo || v > hi)
    throw new AsmError(`${what} out of range: ${v} does not fit in ${bits} bits`, line);
}

// Emit segment prefix (if any) for a memory operand.
function segPrefix(bytes, op) {
  if (op.kind === 'mem' && op.seg) u8(bytes, SEG_PREFIX[op.seg]);
}

// Emit ModRM (+displacement) for reg field + r/m operand.
function modrm(bytes, regField, rm, ctx) {
  if (rm.kind === 'r8' || rm.kind === 'r16') {
    u8(bytes, 0xC0 | (regField << 3) | rm.code);
    return;
  }
  // memory
  if (rm.direct) {
    u8(bytes, 0x00 | (regField << 3) | 6);
    const d = evalExpr(rm.dispExpr, ctx);
    checkRange(d.value, 16, true, 'address', ctx.line);
    u16(bytes, d.value || 0);
    return;
  }
  let mod, dispVal = 0, dispSize = 0;
  if (!rm.dispExpr) {
    if (rm.rm === 6) { mod = 1; dispSize = 1; } // [bp] needs disp8=0
    else mod = 0;
  } else {
    const d = evalExpr(rm.dispExpr, ctx);
    if (d.isConst && d.value !== undefined) {
      dispVal = d.value;
      checkRange(dispVal, 16, true, 'displacement', ctx.line);
      if (dispVal === 0 && rm.rm !== 6) mod = 0;
      else if (dispVal >= -128 && dispVal <= 127) { mod = 1; dispSize = 1; }
      else { mod = 2; dispSize = 2; }
    } else {
      // symbolic displacement: always 16-bit so pass-1 sizing is stable
      dispVal = d.value || 0;
      checkRange(d.value, 16, true, 'displacement', ctx.line);
      mod = 2; dispSize = 2;
    }
  }
  u8(bytes, (mod << 6) | (regField << 3) | rm.rm);
  if (dispSize === 1) u8(bytes, dispVal);
  else if (dispSize === 2) u16(bytes, dispVal);
}

function emitImm(bytes, expr, size, ctx, what = 'immediate') {
  const d = evalExpr(expr, ctx);
  checkRange(d.value, size * 8, true, what, ctx.line);
  if (size === 1) u8(bytes, d.value || 0);
  else u16(bytes, d.value || 0);
  return d;
}

/* ----------------------------------------------------- operand size logic */

function opSize(op) {
  if (op.kind === 'r8') return 1;
  if (op.kind === 'r16' || op.kind === 'sreg') return 2;
  return op.size; // mem/imm: explicit override or null
}

function requireSize(a, b, mnem, line) {
  const sa = opSize(a), sb = opSize(b);
  if (sa && sb && sa !== sb)
    throw new AsmError(`operand size mismatch in ${mnem}`, line);
  const s = sa || sb;
  if (!s) throw new AsmError(`operand size unknown in ${mnem}; use BYTE PTR or WORD PTR`, line);
  return s;
}

function isAcc(op) {
  return (op.kind === 'r8' || op.kind === 'r16') && op.code === 0;
}
function isRM(op) { return op.kind === 'r8' || op.kind === 'r16' || op.kind === 'mem'; }

/* ------------------------------------------------------------ instructions */

function need(ops, n, mnem, line) {
  if (ops.length !== n)
    throw new AsmError(`${mnem} expects ${n} operand${n === 1 ? '' : 's'}, got ${ops.length}`, line);
}

function aluHandler(idx) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 2, mnem, ctx.line);
    const [d, s] = ops;
    if (s.kind === 'imm') {
      if (!isRM(d)) throw new AsmError(`bad destination for ${mnem}`, ctx.line);
      const size = requireSize(d, s, mnem, ctx.line);
      const w = size === 2 ? 1 : 0;
      if (isAcc(d)) {
        u8(bytes, (idx << 3) | 4 | w);
        emitImm(bytes, s.expr, size, ctx);
        return;
      }
      segPrefix(bytes, d);
      const e = evalExpr(s.expr, ctx);
      if (w && e.isConst && e.value !== undefined && e.value >= -128 && e.value <= 127) {
        u8(bytes, 0x83); modrm(bytes, idx, d, ctx); u8(bytes, e.value);
      } else {
        u8(bytes, w ? 0x81 : 0x80); modrm(bytes, idx, d, ctx);
        emitImm(bytes, s.expr, size, ctx);
      }
      return;
    }
    const size = requireSize(d, s, mnem, ctx.line);
    const w = size === 2 ? 1 : 0;
    if ((d.kind === 'r8' || d.kind === 'r16') && isRM(s)) {
      if (s.kind === 'mem') {
        segPrefix(bytes, s);
        u8(bytes, (idx << 3) | 2 | w); modrm(bytes, d.code, s, ctx);
      } else {
        u8(bytes, (idx << 3) | 0 | w); modrm(bytes, s.code, d, ctx);
      }
      return;
    }
    if (d.kind === 'mem' && (s.kind === 'r8' || s.kind === 'r16')) {
      segPrefix(bytes, d);
      u8(bytes, (idx << 3) | 0 | w); modrm(bytes, s.code, d, ctx);
      return;
    }
    throw new AsmError(`invalid operands for ${mnem}`, ctx.line);
  };
}

function movHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  const [d, s] = ops;
  // segment register moves
  if (d.kind === 'sreg') {
    if (d.name === 'CS') throw new AsmError('MOV CS, ... is not allowed', ctx.line);
    if (!(s.kind === 'r16' || (s.kind === 'mem' && (s.size === null || s.size === 2))))
      throw new AsmError('MOV sreg needs a 16-bit register or memory source', ctx.line);
    segPrefix(bytes, s);
    u8(bytes, 0x8E); modrm(bytes, d.code, s, ctx);
    return;
  }
  if (s.kind === 'sreg') {
    if (!(d.kind === 'r16' || (d.kind === 'mem' && (d.size === null || d.size === 2))))
      throw new AsmError('MOV from sreg needs a 16-bit destination', ctx.line);
    segPrefix(bytes, d);
    u8(bytes, 0x8C); modrm(bytes, s.code, d, ctx);
    return;
  }
  if (s.kind === 'imm') {
    if (d.kind === 'r8') { u8(bytes, 0xB0 + d.code); emitImm(bytes, s.expr, 1, ctx); return; }
    if (d.kind === 'r16') { u8(bytes, 0xB8 + d.code); emitImm(bytes, s.expr, 2, ctx); return; }
    if (d.kind === 'mem') {
      const size = requireSize(d, s, mnem, ctx.line);
      segPrefix(bytes, d);
      u8(bytes, size === 2 ? 0xC7 : 0xC6); modrm(bytes, 0, d, ctx);
      emitImm(bytes, s.expr, size, ctx);
      return;
    }
    throw new AsmError('invalid MOV destination', ctx.line);
  }
  const size = requireSize(d, s, mnem, ctx.line);
  const w = size === 2 ? 1 : 0;
  if ((d.kind === 'r8' || d.kind === 'r16') && s.kind === 'mem') {
    segPrefix(bytes, s);
    u8(bytes, 0x8A | w); modrm(bytes, d.code, s, ctx);
    return;
  }
  if (d.kind === 'mem' && (s.kind === 'r8' || s.kind === 'r16')) {
    segPrefix(bytes, d);
    u8(bytes, 0x88 | w); modrm(bytes, s.code, d, ctx);
    return;
  }
  if ((d.kind === 'r8' || d.kind === 'r16') && (s.kind === 'r8' || s.kind === 'r16')) {
    u8(bytes, 0x88 | w); modrm(bytes, s.code, d, ctx);
    return;
  }
  throw new AsmError('invalid operands for MOV', ctx.line);
}

function incDec(ext) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 1, mnem, ctx.line);
    const d = ops[0];
    if (d.kind === 'r16') { u8(bytes, (ext === 0 ? 0x40 : 0x48) + d.code); return; }
    if (d.kind === 'r8') { u8(bytes, 0xFE); modrm(bytes, ext, d, ctx); return; }
    if (d.kind === 'mem') {
      const size = d.size;
      if (!size) throw new AsmError(`${mnem}: use BYTE PTR or WORD PTR for memory operand`, ctx.line);
      segPrefix(bytes, d);
      u8(bytes, size === 2 ? 0xFF : 0xFE); modrm(bytes, ext, d, ctx);
      return;
    }
    throw new AsmError(`invalid operand for ${mnem}`, ctx.line);
  };
}

function groupF7(ext) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 1, mnem, ctx.line);
    const d = ops[0];
    if (!isRM(d)) throw new AsmError(`invalid operand for ${mnem}`, ctx.line);
    const size = opSize(d);
    if (!size) throw new AsmError(`${mnem}: use BYTE PTR or WORD PTR for memory operand`, ctx.line);
    segPrefix(bytes, d);
    u8(bytes, size === 2 ? 0xF7 : 0xF6); modrm(bytes, ext, d, ctx);
  };
}

function shiftHandler(ext) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 2, mnem, ctx.line);
    const [d, c] = ops;
    if (!isRM(d)) throw new AsmError(`invalid operand for ${mnem}`, ctx.line);
    const size = opSize(d);
    if (!size) throw new AsmError(`${mnem}: use BYTE PTR or WORD PTR for memory operand`, ctx.line);
    const w = size === 2 ? 1 : 0;
    if (c.kind === 'r8' && c.name === 'CL') {
      segPrefix(bytes, d);
      u8(bytes, 0xD2 | w); modrm(bytes, ext, d, ctx);
      return;
    }
    if (c.kind === 'imm') {
      const e = evalExpr(c.expr, ctx);
      if (e.value !== undefined && e.value !== 1)
        throw new AsmError(`8086 only supports shift/rotate by 1 or by CL (got ${e.value})`, ctx.line);
      segPrefix(bytes, d);
      u8(bytes, 0xD0 | w); modrm(bytes, ext, d, ctx);
      return;
    }
    throw new AsmError(`${mnem} count must be 1 or CL`, ctx.line);
  };
}

function relJump(opcode) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 1, mnem, ctx.line);
    const t = ops[0];
    if (t.kind !== 'imm') throw new AsmError(`${mnem} needs a label or address`, ctx.line);
    const e = evalExpr(t.expr, ctx);
    u8(bytes, opcode);
    let rel = 0;
    if (e.value !== undefined) {
      rel = e.value - (ctx.addr + 2);
      if (ctx.pass === 2 && (rel < -128 || rel > 127))
        throw new AsmError(`${mnem} target out of range (${rel} bytes; must be -128..127)`, ctx.line);
    }
    u8(bytes, rel);
  };
}

function jmpHandler(mnem, ops, ctx, bytes) {
  need(ops, 1, mnem, ctx.line);
  const t = ops[0];
  if (t.kind === 'r16') { u8(bytes, 0xFF); modrm(bytes, 4, t, ctx); return; }
  if (t.kind === 'mem') {
    if (t.size === 1) throw new AsmError('JMP memory operand must be 16-bit', ctx.line);
    segPrefix(bytes, t);
    u8(bytes, 0xFF); modrm(bytes, 4, t, ctx);
    return;
  }
  if (t.kind === 'imm') {
    const e = evalExpr(t.expr, ctx);
    if (t.short) {
      u8(bytes, 0xEB);
      let rel = 0;
      if (e.value !== undefined) {
        rel = e.value - (ctx.addr + 2);
        if (ctx.pass === 2 && (rel < -128 || rel > 127))
          throw new AsmError(`JMP SHORT target out of range (${rel} bytes)`, ctx.line);
      }
      u8(bytes, rel);
    } else {
      u8(bytes, 0xE9);
      u16(bytes, e.value === undefined ? 0 : e.value - (ctx.addr + 3));
    }
    return;
  }
  throw new AsmError('invalid JMP operand', ctx.line);
}

function callHandler(mnem, ops, ctx, bytes) {
  need(ops, 1, mnem, ctx.line);
  const t = ops[0];
  if (t.kind === 'r16') { u8(bytes, 0xFF); modrm(bytes, 2, t, ctx); return; }
  if (t.kind === 'mem') {
    if (t.size === 1) throw new AsmError('CALL memory operand must be 16-bit', ctx.line);
    segPrefix(bytes, t);
    u8(bytes, 0xFF); modrm(bytes, 2, t, ctx);
    return;
  }
  if (t.kind === 'imm') {
    const e = evalExpr(t.expr, ctx);
    u8(bytes, 0xE8);
    u16(bytes, e.value === undefined ? 0 : e.value - (ctx.addr + 3));
    return;
  }
  throw new AsmError('invalid CALL operand', ctx.line);
}

const PUSH_SREG = { ES:0x06, CS:0x0E, SS:0x16, DS:0x1E };
const POP_SREG  = { ES:0x07, SS:0x17, DS:0x1F };

function pushPop(mnem, ops, ctx, bytes) {
  need(ops, 1, mnem, ctx.line);
  const d = ops[0];
  const isPush = mnem === 'PUSH';
  if (d.kind === 'sreg') {
    const tab = isPush ? PUSH_SREG : POP_SREG;
    if (!(d.name in tab)) throw new AsmError(`POP ${d.name} is not allowed`, ctx.line);
    u8(bytes, tab[d.name]);
    return;
  }
  if (d.kind === 'r16') { u8(bytes, (isPush ? 0x50 : 0x58) + d.code); return; }
  if (d.kind === 'mem') {
    if (d.size === 1) throw new AsmError(`${mnem} memory operand must be 16-bit`, ctx.line);
    segPrefix(bytes, d);
    if (isPush) { u8(bytes, 0xFF); modrm(bytes, 6, d, ctx); }
    else { u8(bytes, 0x8F); modrm(bytes, 0, d, ctx); }
    return;
  }
  if (d.kind === 'r8') throw new AsmError(`${mnem} needs a 16-bit operand`, ctx.line);
  throw new AsmError(`8086 has no ${mnem} immediate`, ctx.line);
}

function testHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  let [d, s] = ops;
  if (s.kind === 'imm') {
    if (!isRM(d)) throw new AsmError('invalid TEST operands', ctx.line);
    const size = requireSize(d, s, mnem, ctx.line);
    if (isAcc(d)) {
      u8(bytes, size === 2 ? 0xA9 : 0xA8);
      emitImm(bytes, s.expr, size, ctx);
      return;
    }
    segPrefix(bytes, d);
    u8(bytes, size === 2 ? 0xF7 : 0xF6); modrm(bytes, 0, d, ctx);
    emitImm(bytes, s.expr, size, ctx);
    return;
  }
  // TEST is commutative; canonical form is r/m, reg
  if ((d.kind === 'r8' || d.kind === 'r16') && s.kind === 'mem') [d, s] = [s, d];
  if (isRM(d) && (s.kind === 'r8' || s.kind === 'r16')) {
    const size = requireSize(d, s, mnem, ctx.line);
    segPrefix(bytes, d);
    u8(bytes, size === 2 ? 0x85 : 0x84); modrm(bytes, s.code, d, ctx);
    return;
  }
  throw new AsmError('invalid TEST operands', ctx.line);
}

function xchgHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  let [d, s] = ops;
  if (d.kind === 'r16' && s.kind === 'r16' && (d.code === 0 || s.code === 0)) {
    u8(bytes, 0x90 + (d.code === 0 ? s.code : d.code));
    return;
  }
  if ((d.kind === 'r8' || d.kind === 'r16') && s.kind === 'mem') [d, s] = [s, d];
  const size = requireSize(d, s, mnem, ctx.line);
  const w = size === 2 ? 1 : 0;
  if (isRM(d) && (s.kind === 'r8' || s.kind === 'r16')) {
    segPrefix(bytes, d);
    u8(bytes, 0x86 | w); modrm(bytes, s.code, d, ctx);
    return;
  }
  throw new AsmError('invalid XCHG operands', ctx.line);
}

function leaHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  const [d, s] = ops;
  if (d.kind !== 'r16' || s.kind !== 'mem')
    throw new AsmError('LEA needs: LEA r16, [mem]', ctx.line);
  u8(bytes, 0x8D); modrm(bytes, d.code, s, ctx);
}

function intHandler(mnem, ops, ctx, bytes) {
  need(ops, 1, mnem, ctx.line);
  if (ops[0].kind !== 'imm') throw new AsmError('INT needs an immediate', ctx.line);
  u8(bytes, 0xCD);
  emitImm(bytes, ops[0].expr, 1, ctx, 'interrupt number');
}

function retHandler(opcode, opcodeImm) {
  return (mnem, ops, ctx, bytes) => {
    if (ops.length === 0) { u8(bytes, opcode); return; }
    need(ops, 1, mnem, ctx.line);
    if (ops[0].kind !== 'imm') throw new AsmError(`${mnem} operand must be an immediate`, ctx.line);
    u8(bytes, opcodeImm);
    const e = evalExpr(ops[0].expr, ctx);
    checkRange(e.value, 16, false, 'RET immediate', ctx.line);
    u16(bytes, e.value || 0);
  };
}

function inHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  const [d, s] = ops;
  if (!isAcc(d)) throw new AsmError('IN destination must be AL or AX', ctx.line);
  const w = d.kind === 'r16' ? 1 : 0;
  if (s.kind === 'r16' && s.name === 'DX') { u8(bytes, 0xEC | w); return; }
  if (s.kind === 'imm') { u8(bytes, 0xE4 | w); emitImm(bytes, s.expr, 1, ctx, 'port'); return; }
  throw new AsmError('IN source must be an imm8 port or DX', ctx.line);
}

function outHandler(mnem, ops, ctx, bytes) {
  need(ops, 2, mnem, ctx.line);
  const [d, s] = ops;
  if (!isAcc(s)) throw new AsmError('OUT source must be AL or AX', ctx.line);
  const w = s.kind === 'r16' ? 1 : 0;
  if (d.kind === 'r16' && d.name === 'DX') { u8(bytes, 0xEE | w); return; }
  if (d.kind === 'imm') { u8(bytes, 0xE6 | w); emitImm(bytes, d.expr, 1, ctx, 'port'); return; }
  throw new AsmError('OUT destination must be an imm8 port or DX', ctx.line);
}

function simple(...opcodes) {
  return (mnem, ops, ctx, bytes) => {
    need(ops, 0, mnem, ctx.line);
    for (const b of opcodes) u8(bytes, b);
  };
}

const JCC = {
  JO:0x70, JNO:0x71,
  JB:0x72, JNAE:0x72, JC:0x72,
  JNB:0x73, JAE:0x73, JNC:0x73,
  JE:0x74, JZ:0x74,
  JNE:0x75, JNZ:0x75,
  JBE:0x76, JNA:0x76,
  JA:0x77, JNBE:0x77,
  JS:0x78, JNS:0x79,
  JP:0x7A, JPE:0x7A,
  JNP:0x7B, JPO:0x7B,
  JL:0x7C, JNGE:0x7C,
  JGE:0x7D, JNL:0x7D,
  JLE:0x7E, JNG:0x7E,
  JG:0x7F, JNLE:0x7F,
};

const PREFIXES = { REP:0xF3, REPE:0xF3, REPZ:0xF3, REPNE:0xF2, REPNZ:0xF2, LOCK:0xF0 };

const INSTR = {
  MOV: movHandler,
  ADD: aluHandler(0), OR: aluHandler(1), ADC: aluHandler(2), SBB: aluHandler(3),
  AND: aluHandler(4), SUB: aluHandler(5), XOR: aluHandler(6), CMP: aluHandler(7),
  INC: incDec(0), DEC: incDec(1),
  NOT: groupF7(2), NEG: groupF7(3),
  MUL: groupF7(4), IMUL: groupF7(5), DIV: groupF7(6), IDIV: groupF7(7),
  ROL: shiftHandler(0), ROR: shiftHandler(1), RCL: shiftHandler(2), RCR: shiftHandler(3),
  SHL: shiftHandler(4), SAL: shiftHandler(4), SHR: shiftHandler(5), SAR: shiftHandler(7),
  PUSH: pushPop, POP: pushPop,
  TEST: testHandler, XCHG: xchgHandler, LEA: leaHandler,
  JMP: jmpHandler, CALL: callHandler,
  RET: retHandler(0xC3, 0xC2), RETN: retHandler(0xC3, 0xC2), RETF: retHandler(0xCB, 0xCA),
  INT: intHandler,
  LOOP: relJump(0xE2), LOOPE: relJump(0xE1), LOOPZ: relJump(0xE1),
  LOOPNE: relJump(0xE0), LOOPNZ: relJump(0xE0), JCXZ: relJump(0xE3),
  IN: inHandler, OUT: outHandler,
  NOP: simple(0x90), HLT: simple(0xF4), WAIT: simple(0x9B),
  CLC: simple(0xF8), STC: simple(0xF9), CMC: simple(0xF5),
  CLD: simple(0xFC), STD: simple(0xFD), CLI: simple(0xFA), STI: simple(0xFB),
  CBW: simple(0x98), CWD: simple(0x99),
  LAHF: simple(0x9F), SAHF: simple(0x9E),
  PUSHF: simple(0x9C), POPF: simple(0x9D),
  XLAT: simple(0xD7), XLATB: simple(0xD7),
  AAA: simple(0x37), AAS: simple(0x3F), DAA: simple(0x27), DAS: simple(0x2F),
  AAM: simple(0xD4, 0x0A), AAD: simple(0xD5, 0x0A),
  IRET: simple(0xCF), INT3: simple(0xCC), INTO: simple(0xCE),
  MOVSB: simple(0xA4), MOVSW: simple(0xA5),
  CMPSB: simple(0xA6), CMPSW: simple(0xA7),
  STOSB: simple(0xAA), STOSW: simple(0xAB),
  LODSB: simple(0xAC), LODSW: simple(0xAD),
  SCASB: simple(0xAE), SCASW: simple(0xAF),
};

for (const [name, op] of Object.entries(JCC)) INSTR[name] = relJump(op);

const DIRECTIVES = new Set(['ORG', 'DB', 'DW', 'EQU', 'END']);

/* ------------------------------------------------------------ line parsing */

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; }
    else if (c === "'" || c === '"') q = c;
    else if (c === ';') return line.slice(0, i);
  }
  return line;
}

function splitOperands(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map(x => x.trim()).filter(x => x !== '');
}

// Parse a source line into { label, mnem, operandText }
function parseLine(text, lineNo) {
  let s = stripComment(text).trim();
  if (!s) return null;
  let label = null;

  const lm = s.match(/^([A-Za-z_.@?][A-Za-z0-9_.@?]*)\s*:/);
  if (lm) {
    label = lm[1];
    s = s.slice(lm[0].length).trim();
  }
  if (!s) return { label, mnem: null, operandText: '' };

  const wm = s.match(/^([A-Za-z_.@?][A-Za-z0-9_.@?]*)/);
  if (!wm) throw new AsmError(`cannot parse line: ${s}`, lineNo);
  let first = wm[1];
  let rest = s.slice(first.length).trim();

  // "name DB ..." / "name DW ..." / "name EQU ..." (label without colon)
  const firstUp = first.toUpperCase();
  if (!(firstUp in INSTR) && !DIRECTIVES.has(firstUp) && !(firstUp in PREFIXES)) {
    const wm2 = rest.match(/^([A-Za-z_.@?][A-Za-z0-9_.@?]*)/);
    const second = wm2 && wm2[1].toUpperCase();
    if (second && (second === 'DB' || second === 'DW' || second === 'EQU')) {
      if (label) throw new AsmError('two labels on one line', lineNo);
      label = first;
      first = second;
      rest = rest.slice(wm2[1].length).trim();
    } else {
      throw new AsmError(`unknown instruction '${first}'`, lineNo);
    }
  }
  return { label, mnem: first.toUpperCase(), operandText: rest };
}

/* ---------------------------------------------------------------- DB / DW */

function emitData(mnem, operandText, ctx, bytes) {
  const items = splitOperands(operandText);
  if (!items.length) throw new AsmError(`${mnem} needs at least one value`, ctx.line);
  for (const item of items) emitDataItem(mnem, item, ctx, bytes);
}

function emitDataItem(mnem, item, ctx, bytes) {
  const size = mnem === 'DB' ? 1 : 2;
  // n DUP(value)
  const dm = item.match(/^(.+?)\s+dup\s*\((.*)\)\s*$/i);
  if (dm) {
    // The count must be known already in pass 1 (backward references only),
    // otherwise the size of this statement could change between passes.
    const cnt = evalExpr(dm[1], ctx);
    if (cnt.value === undefined)
      throw new AsmError('DUP count must not use forward references', ctx.line);
    if (cnt.value < 0 || cnt.value > 65536)
      throw new AsmError(`bad DUP count: ${cnt.value}`, ctx.line);
    const inner = dm[2].trim();
    for (let i = 0; i < cnt.value; i++) emitDataItem(mnem, inner || '?', ctx, bytes);
    return;
  }
  if (item === '?') {
    if (size === 1) u8(bytes, 0); else u16(bytes, 0);
    return;
  }
  // string literal (only meaningful for DB; 2+ chars in DW is an error)
  const sm = item.match(/^(['"])([\s\S]*)\1$/);
  if (sm) {
    const str = sm[2];
    if (mnem === 'DW' && str.length !== 1)
      throw new AsmError('DW accepts only single-character literals', ctx.line);
    if (str.length === 0) throw new AsmError('empty string literal', ctx.line);
    if (mnem === 'DB') { for (const ch of str) u8(bytes, ch.charCodeAt(0)); }
    else u16(bytes, str.charCodeAt(0));
    return;
  }
  const e = evalExpr(item, ctx);
  checkRange(e.value, size * 8, true, `${mnem} value`, ctx.line);
  if (size === 1) u8(bytes, e.value || 0);
  else u16(bytes, e.value || 0);
}

/* ----------------------------------------------------------- the assembler */

function assemble(source) {
  const rawLines = source.split(/\r?\n/);
  const errors = [];
  const stmts = [];

  for (let i = 0; i < rawLines.length; i++) {
    try {
      const st = parseLine(rawLines[i], i + 1);
      if (st) stmts.push({ ...st, line: i + 1, text: rawLines[i] });
    } catch (e) {
      if (e instanceof AsmError) errors.push({ line: e.line, message: e.message });
      else throw e;
    }
  }

  const symbols = new Map();
  const listing = [];
  let origin = 0;

  function encodeStmt(st, ctx) {
    const bytes = [];
    let { mnem } = st;
    let operandText = st.operandText;

    // prefix (REP etc.) possibly followed by an instruction on the same line
    while (mnem && mnem in PREFIXES) {
      u8(bytes, PREFIXES[mnem]);
      if (!operandText) return bytes;
      const inner = parseLine(operandText, st.line);
      if (!inner || !inner.mnem) return bytes;
      if (inner.label) throw new AsmError('label not allowed after prefix', st.line);
      mnem = inner.mnem;
      operandText = inner.operandText;
    }
    if (!mnem) return bytes;

    if (mnem === 'DB' || mnem === 'DW') { emitData(mnem, operandText, ctx, bytes); return bytes; }
    const handler = INSTR[mnem];
    if (!handler) throw new AsmError(`unknown instruction '${mnem}'`, st.line);
    const ops = splitOperands(operandText).map(o => parseOperand(o, st.line));
    handler(mnem, ops, ctx, bytes);
    return bytes;
  }

  for (const pass of [1, 2]) {
    let addr = origin;
    let emitted = false;
    let ended = false;

    for (const st of stmts) {
      if (ended) break;
      const ctx = { pass, symbols, line: st.line, addr };
      try {
        if (st.mnem === 'END') { ended = true; continue; }
        if (st.mnem === 'EQU') {
          if (!st.label) throw new AsmError('EQU needs a name: name EQU value', st.line);
          const e = evalExpr(st.operandText, ctx);
          if (pass === 1 && e.value === undefined)
            throw new AsmError(`EQU '${st.label}' uses a symbol that is not yet defined`, st.line);
          setSymbol(symbols, st.label, e.value, e.isConst, pass, st.line);
          if (pass === 2) listing.push({ line: st.line, addr: null, bytes: [], text: st.text });
          continue;
        }
        if (st.mnem === 'ORG') {
          if (emitted) throw new AsmError('ORG must come before any code or data', st.line);
          const e = evalExpr(st.operandText, ctx);
          if (!e.isConst || e.value === undefined)
            throw new AsmError('ORG needs a constant value', st.line);
          checkRange(e.value, 16, false, 'ORG address', st.line);
          if (st.label) setSymbol(symbols, st.label, e.value, false, pass, st.line);
          origin = e.value;
          addr = e.value;
          if (pass === 2) listing.push({ line: st.line, addr: null, bytes: [], text: st.text });
          continue;
        }
        if (st.label) setSymbol(symbols, st.label, addr, false, pass, st.line);

        const bytes = encodeStmt(st, ctx);
        if (bytes.length) emitted = true;

        if (pass === 1) {
          st.size = bytes.length;
        } else {
          if (bytes.length !== st.size)
            throw new AsmError(`internal error: instruction size changed between passes (${st.size} → ${bytes.length})`, st.line);
          listing.push({ line: st.line, addr, bytes, text: st.text });
        }
        addr += bytes.length;
        if (addr > 0x10000) throw new AsmError('program exceeds 64 KiB', st.line);
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        if (pass === 2 || e.message.includes('not yet defined') || pass === 1) {
          // report each line's error once (pass 2 preferred; pass-1-only errors still surface)
          if (pass === 2 || st.size === undefined) {
            if (!errors.some(x => x.line === e.line)) errors.push({ line: e.line, message: e.message });
          }
        }
        if (pass === 1 && st.size === undefined) st.size = 0;
        addr += st.size || 0;
      }
    }
  }

  errors.sort((a, b) => a.line - b.line);

  let bin = new Uint8Array(0);
  if (!errors.length) {
    const all = [];
    for (const l of listing) for (const b of l.bytes) all.push(b);
    bin = Uint8Array.from(all);
  }

  const symbolList = [...symbols.entries()]
    .map(([name, s]) => ({ name, value: s.value, isConst: s.isConst }))
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0));

  return { bytes: bin, origin, listing, errors, symbols: symbolList, ok: errors.length === 0 };
}

function setSymbol(symbols, name, value, isConst, pass, line) {
  const key = name.toUpperCase();
  if (key in REG8 || key in REG16 || key in SREG || key in INSTR || DIRECTIVES.has(key) || key in PREFIXES)
    throw new AsmError(`'${name}' is a reserved word`, line);
  if (pass === 1 && symbols.has(key))
    throw new AsmError(`duplicate symbol '${name}'`, line);
  symbols.set(key, { value, isConst });
}

const api = {
  assemble, AsmError,
  KEYWORDS: [...Object.keys(INSTR), ...DIRECTIVES, ...Object.keys(PREFIXES),
             'BYTE', 'WORD', 'PTR', 'SHORT', 'DUP'],
  REGISTERS: [...Object.keys(REG8), ...Object.keys(REG16), ...Object.keys(SREG)],
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else global.Assembler8086 = api;

})(typeof window !== 'undefined' ? window : globalThis);
