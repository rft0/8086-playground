/*
 * 8086 CPU emulator. Executes flat binaries produced by the assembler
 * (COM model: CS=DS=ES=SS, IP=origin, SP=0xFFFE).
 * Works in the browser (global `Emu8086`) and in Node (module.exports).
 */
(function (global) {
'use strict';

const F_CF = 0x0001, F_PF = 0x0004, F_AF = 0x0010, F_ZF = 0x0040,
      F_SF = 0x0080, F_TF = 0x0100, F_IF = 0x0200, F_DF = 0x0400, F_OF = 0x0800;

const ES = 0, CS = 1, SS = 2, DS = 3;

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, n = 0;
  while (b) { n += b & 1; b >>= 1; }
  PARITY[i] = (n & 1) ? 0 : 1;
}

class EmuError extends Error {}

class CPU8086 {
  constructor() {
    this.mem = new Uint8Array(0x100000);
    // intHook(cpu, n) -> true (handled) | 'wait' (re-run INT later) | false
    this.intHook = null;
    this.reset();
  }

  reset() {
    this.regs = new Uint16Array(8);   // AX CX DX BX SP BP SI DI
    this.sregs = new Uint16Array(4);  // ES CS SS DS
    this.ip = 0;
    this.flags = 0x0002;
    this.halted = false;
    this.exited = false;
    this.exitCode = 0;
    this.waiting = false;
    this.instrCount = 0;
    this.segOverride = null;
    this.rep = 0;
  }

  // Load a flat binary as a COM-style image at segment loadSeg, offset = origin.
  load(bytes, origin, loadSeg = 0x1000) {
    this.reset();
    this.mem.fill(0);
    const base = (loadSeg << 4) + origin;
    this.mem.set(bytes, base);
    this.sregs[ES] = this.sregs[CS] = this.sregs[SS] = this.sregs[DS] = loadSeg;
    this.ip = origin & 0xFFFF;
    this.regs[4] = 0xFFFE; // SP
    // CP/M-style return: word 0 of the segment holds INT 20h, and the word
    // at the top of the stack points at it, so a bare RET exits cleanly.
    // Only possible when the origin leaves room for the stub (e.g. ORG 100h).
    if (origin >= 2) {
      this.mem[(loadSeg << 4) + 0] = 0xCD;
      this.mem[(loadSeg << 4) + 1] = 0x20;
    }
    this.write16(SS, 0xFFFE, 0x0000);
  }

  /* ---- register access ---- */
  r16(i) { return this.regs[i]; }
  w16(i, v) { this.regs[i] = v & 0xFFFF; }
  r8(i) { return i < 4 ? this.regs[i] & 0xFF : (this.regs[i - 4] >> 8) & 0xFF; }
  w8(i, v) {
    v &= 0xFF;
    if (i < 4) this.regs[i] = (this.regs[i] & 0xFF00) | v;
    else this.regs[i - 4] = (this.regs[i - 4] & 0x00FF) | (v << 8);
  }
  get ax() { return this.regs[0]; }  set ax(v) { this.regs[0] = v & 0xFFFF; }
  get cx() { return this.regs[1]; }  set cx(v) { this.regs[1] = v & 0xFFFF; }
  get dx() { return this.regs[2]; }  set dx(v) { this.regs[2] = v & 0xFFFF; }
  get bx() { return this.regs[3]; }  set bx(v) { this.regs[3] = v & 0xFFFF; }
  get sp() { return this.regs[4]; }  set sp(v) { this.regs[4] = v & 0xFFFF; }
  get al() { return this.regs[0] & 0xFF; }
  get ah() { return (this.regs[0] >> 8) & 0xFF; }
  get dl() { return this.regs[2] & 0xFF; }

  getF(f) { return (this.flags & f) !== 0; }
  setF(f, v) { if (v) this.flags |= f; else this.flags &= ~f; }

  /* ---- memory ---- */
  phys(seg, off) { return ((this.sregs[seg] << 4) + (off & 0xFFFF)) & 0xFFFFF; }
  read8(seg, off) { return this.mem[this.phys(seg, off)]; }
  read16(seg, off) { return this.read8(seg, off) | (this.read8(seg, off + 1) << 8); }
  write8(seg, off, v) { this.mem[this.phys(seg, off)] = v & 0xFF; }
  write16(seg, off, v) { this.write8(seg, off, v); this.write8(seg, off + 1, v >> 8); }

  fetch8() { const v = this.read8(CS, this.ip); this.ip = (this.ip + 1) & 0xFFFF; return v; }
  fetch16() { return this.fetch8() | (this.fetch8() << 8); }

  push16(v) { this.sp = (this.sp - 2) & 0xFFFF; this.write16(SS, this.sp, v); }
  pop16() { const v = this.read16(SS, this.sp); this.sp = (this.sp + 2) & 0xFFFF; return v; }

  /* ---- ModRM ---- */
  decodeModRM() {
    const b = this.fetch8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { mod, reg, rm, isReg: true };
    let off, seg;
    const r = this.regs;
    switch (rm) {
      case 0: off = r[3] + r[6]; seg = DS; break;            // [BX+SI]
      case 1: off = r[3] + r[7]; seg = DS; break;            // [BX+DI]
      case 2: off = r[5] + r[6]; seg = SS; break;            // [BP+SI]
      case 3: off = r[5] + r[7]; seg = SS; break;            // [BP+DI]
      case 4: off = r[6]; seg = DS; break;                   // [SI]
      case 5: off = r[7]; seg = DS; break;                   // [DI]
      case 6: off = mod === 0 ? 0 : r[5]; seg = mod === 0 ? DS : SS; break; // disp16 / [BP]
      case 7: off = r[3]; seg = DS; break;                   // [BX]
    }
    if (mod === 0 && rm === 6) off = this.fetch16();
    else if (mod === 1) { let d = this.fetch8(); if (d & 0x80) d -= 0x100; off += d; }
    else if (mod === 2) off += this.fetch16();
    if (this.segOverride !== null) seg = this.segOverride;
    return { mod, reg, rm, isReg: false, seg, off: off & 0xFFFF };
  }
  readRM8(m) { return m.isReg ? this.r8(m.rm) : this.read8(m.seg, m.off); }
  readRM16(m) { return m.isReg ? this.r16(m.rm) : this.read16(m.seg, m.off); }
  writeRM8(m, v) { if (m.isReg) this.w8(m.rm, v); else this.write8(m.seg, m.off, v); }
  writeRM16(m, v) { if (m.isReg) this.w16(m.rm, v); else this.write16(m.seg, m.off, v); }

  /* ---- flags helpers ---- */
  szp(v, w) {
    const mask = w ? 0xFFFF : 0xFF, sign = w ? 0x8000 : 0x80;
    v &= mask;
    this.setF(F_ZF, v === 0);
    this.setF(F_SF, (v & sign) !== 0);
    this.setF(F_PF, PARITY[v & 0xFF]);
  }
  add(a, b, c, w) {
    const mask = w ? 0xFFFF : 0xFF, sign = w ? 0x8000 : 0x80;
    a &= mask; b &= mask;
    const raw = a + b + c, r = raw & mask;
    this.setF(F_CF, raw > mask);
    this.setF(F_AF, ((a ^ b ^ r) & 0x10) !== 0);
    this.setF(F_OF, ((~(a ^ b)) & (a ^ r) & sign) !== 0);
    this.szp(r, w);
    return r;
  }
  sub(a, b, c, w) {
    const mask = w ? 0xFFFF : 0xFF, sign = w ? 0x8000 : 0x80;
    a &= mask; b &= mask;
    const raw = a - b - c, r = raw & mask;
    this.setF(F_CF, raw < 0);
    this.setF(F_AF, ((a ^ b ^ r) & 0x10) !== 0);
    this.setF(F_OF, ((a ^ b) & (a ^ r) & sign) !== 0);
    this.szp(r, w);
    return r;
  }
  logicFlags(r, w) {
    this.setF(F_CF, false); this.setF(F_OF, false); this.setF(F_AF, false);
    this.szp(r, w);
  }
  alu(idx, a, b, w) {
    const c = this.getF(F_CF) ? 1 : 0;
    switch (idx) {
      case 0: return this.add(a, b, 0, w);
      case 1: { const r = a | b; this.logicFlags(r, w); return r; }
      case 2: return this.add(a, b, c, w);
      case 3: return this.sub(a, b, c, w);
      case 4: { const r = a & b; this.logicFlags(r, w); return r; }
      case 5: case 7: return this.sub(a, b, 0, w);
      case 6: { const r = (a ^ b) & (w ? 0xFFFF : 0xFF); this.logicFlags(r, w); return r; }
    }
  }

  /* ---- shifts / rotates ---- */
  shiftOp(ext, v, count, w) {
    const bits = w ? 16 : 8, mask = w ? 0xFFFF : 0xFF, sign = w ? 0x8000 : 0x80;
    if (count === 0) return v;
    let cf = this.getF(F_CF) ? 1 : 0;
    switch (ext) {
      case 0: { // ROL
        const n = count % bits;
        if (n) v = ((v << n) | (v >> (bits - n))) & mask;
        cf = v & 1;
        if (count === 1) this.setF(F_OF, (((v & sign) ? 1 : 0) ^ cf) !== 0);
        this.setF(F_CF, cf !== 0);
        return v;
      }
      case 1: { // ROR
        const n = count % bits;
        if (n) v = ((v >> n) | (v << (bits - n))) & mask;
        cf = (v & sign) ? 1 : 0;
        if (count === 1) this.setF(F_OF, ((v & sign) !== 0) !== ((v & (sign >> 1)) !== 0));
        this.setF(F_CF, cf !== 0);
        return v;
      }
      case 2: { // RCL
        for (let i = 0; i < count % (bits + 1); i++) {
          const nc = (v & sign) ? 1 : 0;
          v = ((v << 1) | cf) & mask;
          cf = nc;
        }
        if (count === 1) this.setF(F_OF, (((v & sign) ? 1 : 0) ^ cf) !== 0);
        this.setF(F_CF, cf !== 0);
        return v;
      }
      case 3: { // RCR
        for (let i = 0; i < count % (bits + 1); i++) {
          const nc = v & 1;
          v = (v >> 1) | (cf ? sign : 0);
          cf = nc;
        }
        if (count === 1) this.setF(F_OF, ((v & sign) !== 0) !== ((v & (sign >> 1)) !== 0));
        this.setF(F_CF, cf !== 0);
        return v;
      }
      case 4: case 6: { // SHL/SAL
        for (let i = 0; i < Math.min(count, bits + 1); i++) {
          cf = (v & sign) ? 1 : 0;
          v = (v << 1) & mask;
        }
        if (count === 1) this.setF(F_OF, (((v & sign) ? 1 : 0) ^ cf) !== 0);
        this.setF(F_CF, cf !== 0);
        this.szp(v, w);
        return v;
      }
      case 5: { // SHR
        if (count === 1) this.setF(F_OF, (v & sign) !== 0);
        for (let i = 0; i < Math.min(count, bits + 1); i++) {
          cf = v & 1;
          v >>= 1;
        }
        this.setF(F_CF, cf !== 0);
        this.szp(v, w);
        return v;
      }
      case 7: { // SAR
        const neg = (v & sign) !== 0;
        for (let i = 0; i < Math.min(count, 32); i++) {
          cf = v & 1;
          v = (v >> 1) | (neg ? sign : 0);
        }
        this.setF(F_OF, false);
        this.setF(F_CF, cf !== 0);
        this.szp(v, w);
        return v;
      }
    }
  }

  /* ---- string ops ---- */
  strDelta(w) { return (this.getF(F_DF) ? -1 : 1) * (w ? 2 : 1); }
  strSrcSeg() { return this.segOverride !== null ? this.segOverride : DS; }

  strOpOnce(op, w) {
    const d = this.strDelta(w), SI = 6, DI = 7;
    switch (op) {
      case 0xA4: case 0xA5: // MOVS
        if (w) this.write16(ES, this.regs[DI], this.read16(this.strSrcSeg(), this.regs[SI]));
        else this.write8(ES, this.regs[DI], this.read8(this.strSrcSeg(), this.regs[SI]));
        this.regs[SI] = (this.regs[SI] + d) & 0xFFFF;
        this.regs[DI] = (this.regs[DI] + d) & 0xFFFF;
        break;
      case 0xA6: case 0xA7: { // CMPS
        const a = w ? this.read16(this.strSrcSeg(), this.regs[SI]) : this.read8(this.strSrcSeg(), this.regs[SI]);
        const b = w ? this.read16(ES, this.regs[DI]) : this.read8(ES, this.regs[DI]);
        this.sub(a, b, 0, w);
        this.regs[SI] = (this.regs[SI] + d) & 0xFFFF;
        this.regs[DI] = (this.regs[DI] + d) & 0xFFFF;
        break;
      }
      case 0xAA: case 0xAB: // STOS
        if (w) this.write16(ES, this.regs[DI], this.ax);
        else this.write8(ES, this.regs[DI], this.al);
        this.regs[DI] = (this.regs[DI] + d) & 0xFFFF;
        break;
      case 0xAC: case 0xAD: // LODS
        if (w) this.ax = this.read16(this.strSrcSeg(), this.regs[SI]);
        else this.w8(0, this.read8(this.strSrcSeg(), this.regs[SI]));
        this.regs[SI] = (this.regs[SI] + d) & 0xFFFF;
        break;
      case 0xAE: case 0xAF: { // SCAS
        const b = w ? this.read16(ES, this.regs[DI]) : this.read8(ES, this.regs[DI]);
        this.sub(w ? this.ax : this.al, b, 0, w);
        this.regs[DI] = (this.regs[DI] + d) & 0xFFFF;
        break;
      }
    }
  }

  strOp(op, w) {
    if (!this.rep) { this.strOpOnce(op, w); return; }
    const isCmp = op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF;
    while (this.cx !== 0) {
      this.strOpOnce(op, w);
      this.cx = this.cx - 1;
      if (isCmp) {
        if (this.rep === 0xF3 && !this.getF(F_ZF)) break;
        if (this.rep === 0xF2 && this.getF(F_ZF)) break;
      }
    }
  }

  /* ---- interrupts ---- */
  doInt(n, instrLen) {
    if (this.intHook) {
      const r = this.intHook(this, n);
      if (r === 'wait') {
        this.ip = (this.ip - instrLen) & 0xFFFF; // re-execute INT when input arrives
        this.waiting = true;
        return;
      }
      if (r) return;
    }
    // fall back to the interrupt vector table
    const vecOff = this.mem[n * 4] | (this.mem[n * 4 + 1] << 8);
    const vecSeg = this.mem[n * 4 + 2] | (this.mem[n * 4 + 3] << 8);
    if (vecSeg === 0 && vecOff === 0)
      throw new EmuError(`unhandled interrupt INT ${n.toString(16).toUpperCase().padStart(2, '0')}h`);
    this.push16(this.flags | 0xF000);
    this.setF(F_IF, false); this.setF(F_TF, false);
    this.push16(this.sregs[CS]);
    this.push16(this.ip);
    this.sregs[CS] = vecSeg;
    this.ip = vecOff;
  }

  condition(code) {
    const f = this.flags;
    switch (code) {
      case 0: return (f & F_OF) !== 0;
      case 1: return (f & F_CF) !== 0;
      case 2: return (f & F_ZF) !== 0;
      case 3: return (f & (F_CF | F_ZF)) !== 0;
      case 4: return (f & F_SF) !== 0;
      case 5: return (f & F_PF) !== 0;
      case 6: return ((f & F_SF) !== 0) !== ((f & F_OF) !== 0);
      case 7: return (((f & F_SF) !== 0) !== ((f & F_OF) !== 0)) || (f & F_ZF) !== 0;
    }
  }

  jmpRel8(taken) {
    let d = this.fetch8();
    if (d & 0x80) d -= 0x100;
    if (taken) this.ip = (this.ip + d) & 0xFFFF;
  }

  /* ---- one instruction ---- */
  step() {
    if (this.halted || this.exited) return;
    this.waiting = false;
    this.segOverride = null;
    this.rep = 0;
    const startIP = this.ip;

    let op;
    for (;;) {
      op = this.fetch8();
      if (op === 0x26) this.segOverride = ES;
      else if (op === 0x2E) this.segOverride = CS;
      else if (op === 0x36) this.segOverride = SS;
      else if (op === 0x3E) this.segOverride = DS;
      else if (op === 0xF0) { /* LOCK */ }
      else if (op === 0xF2 || op === 0xF3) this.rep = op;
      else break;
      if (((this.ip - startIP) & 0xFFFF) > 15)
        throw new EmuError('runaway instruction prefixes');
    }

    this.exec(op, startIP);
    this.instrCount++;
  }

  exec(op, startIP) {
    /* ALU block 00-3F */
    if (op < 0x40 && (op & 7) < 6) {
      const idx = op >> 3, form = op & 7;
      let m, r;
      switch (form) {
        case 0: m = this.decodeModRM(); r = this.alu(idx, this.readRM8(m), this.r8(m.reg), 0);
                if (idx !== 7) this.writeRM8(m, r); return;
        case 1: m = this.decodeModRM(); r = this.alu(idx, this.readRM16(m), this.r16(m.reg), 1);
                if (idx !== 7) this.writeRM16(m, r); return;
        case 2: m = this.decodeModRM(); r = this.alu(idx, this.r8(m.reg), this.readRM8(m), 0);
                if (idx !== 7) this.w8(m.reg, r); return;
        case 3: m = this.decodeModRM(); r = this.alu(idx, this.r16(m.reg), this.readRM16(m), 1);
                if (idx !== 7) this.w16(m.reg, r); return;
        case 4: r = this.alu(idx, this.al, this.fetch8(), 0);
                if (idx !== 7) this.w8(0, r); return;
        case 5: r = this.alu(idx, this.ax, this.fetch16(), 1);
                if (idx !== 7) this.ax = r; return;
      }
    }
    /* PUSH/POP sreg + BCD adjust (06,07,0E,16,17,1E,1F,27,2F,37,3F) */
    switch (op) {
      case 0x06: this.push16(this.sregs[ES]); return;
      case 0x07: this.sregs[ES] = this.pop16(); return;
      case 0x0E: this.push16(this.sregs[CS]); return;
      case 0x16: this.push16(this.sregs[SS]); return;
      case 0x17: this.sregs[SS] = this.pop16(); return;
      case 0x1E: this.push16(this.sregs[DS]); return;
      case 0x1F: this.sregs[DS] = this.pop16(); return;
      case 0x27: { // DAA
        const oldAL = this.al, oldCF = this.getF(F_CF);
        let al = oldAL;
        if ((al & 0x0F) > 9 || this.getF(F_AF)) { al += 6; this.setF(F_AF, true); }
        else this.setF(F_AF, false);
        if (oldAL > 0x99 || oldCF) { al += 0x60; this.setF(F_CF, true); }
        else this.setF(F_CF, false);
        this.w8(0, al); this.szp(this.al, 0);
        return;
      }
      case 0x2F: { // DAS
        const oldAL = this.al, oldCF = this.getF(F_CF);
        let al = oldAL;
        if ((al & 0x0F) > 9 || this.getF(F_AF)) { al -= 6; this.setF(F_AF, true); }
        else this.setF(F_AF, false);
        if (oldAL > 0x99 || oldCF) { al -= 0x60; this.setF(F_CF, true); }
        else this.setF(F_CF, false);
        this.w8(0, al); this.szp(this.al, 0);
        return;
      }
      case 0x37: // AAA
        if ((this.al & 0x0F) > 9 || this.getF(F_AF)) {
          this.w8(0, this.al + 6); this.w8(4, this.ah + 1);
          this.setF(F_AF, true); this.setF(F_CF, true);
        } else { this.setF(F_AF, false); this.setF(F_CF, false); }
        this.w8(0, this.al & 0x0F);
        return;
      case 0x3F: // AAS
        if ((this.al & 0x0F) > 9 || this.getF(F_AF)) {
          this.w8(0, this.al - 6); this.w8(4, this.ah - 1);
          this.setF(F_AF, true); this.setF(F_CF, true);
        } else { this.setF(F_AF, false); this.setF(F_CF, false); }
        this.w8(0, this.al & 0x0F);
        return;
    }
    /* INC/DEC/PUSH/POP r16: 40-5F */
    if (op >= 0x40 && op < 0x48) { // INC keeps CF
      const cf = this.getF(F_CF);
      this.w16(op - 0x40, this.add(this.r16(op - 0x40), 1, 0, 1));
      this.setF(F_CF, cf); return;
    }
    if (op >= 0x48 && op < 0x50) {
      const cf = this.getF(F_CF);
      this.w16(op - 0x48, this.sub(this.r16(op - 0x48), 1, 0, 1));
      this.setF(F_CF, cf); return;
    }
    if (op >= 0x50 && op < 0x58) { this.push16(this.r16(op - 0x50)); return; }
    if (op >= 0x58 && op < 0x60) { this.w16(op - 0x58, this.pop16()); return; }
    /* Jcc 70-7F */
    if (op >= 0x70 && op < 0x80) {
      const cond = this.condition((op >> 1) & 7);
      this.jmpRel8((op & 1) ? !cond : cond);
      return;
    }
    /* MOV r8/r16, imm: B0-BF */
    if (op >= 0xB0 && op < 0xB8) { this.w8(op - 0xB0, this.fetch8()); return; }
    if (op >= 0xB8 && op < 0xC0) { this.w16(op - 0xB8, this.fetch16()); return; }
    /* XCHG AX, r16: 90-97 */
    if (op >= 0x90 && op < 0x98) {
      const i = op - 0x90, t = this.ax;
      this.ax = this.r16(i); this.w16(i, t);
      return;
    }
    /* string ops */
    if (op >= 0xA4 && op <= 0xA7) { this.strOp(op, op & 1); return; }
    if (op >= 0xAA && op <= 0xAF) { this.strOp(op, op & 1); return; }

    switch (op) {
      /* group 80-83: ALU r/m, imm */
      case 0x80: case 0x82: {
        const m = this.decodeModRM(), a = this.readRM8(m), imm = this.fetch8();
        const r = this.alu(m.reg, a, imm, 0);
        if (m.reg !== 7) this.writeRM8(m, r);
        return;
      }
      case 0x81: {
        const m = this.decodeModRM(), a = this.readRM16(m), imm = this.fetch16();
        const r = this.alu(m.reg, a, imm, 1);
        if (m.reg !== 7) this.writeRM16(m, r);
        return;
      }
      case 0x83: {
        const m = this.decodeModRM(), a = this.readRM16(m);
        let imm = this.fetch8(); if (imm & 0x80) imm |= 0xFF00;
        const r = this.alu(m.reg, a, imm, 1);
        if (m.reg !== 7) this.writeRM16(m, r);
        return;
      }
      /* TEST / XCHG r/m */
      case 0x84: { const m = this.decodeModRM(); this.logicFlags(this.readRM8(m) & this.r8(m.reg), 0); return; }
      case 0x85: { const m = this.decodeModRM(); this.logicFlags(this.readRM16(m) & this.r16(m.reg), 1); return; }
      case 0x86: { const m = this.decodeModRM(); const t = this.readRM8(m); this.writeRM8(m, this.r8(m.reg)); this.w8(m.reg, t); return; }
      case 0x87: { const m = this.decodeModRM(); const t = this.readRM16(m); this.writeRM16(m, this.r16(m.reg)); this.w16(m.reg, t); return; }
      /* MOV */
      case 0x88: { const m = this.decodeModRM(); this.writeRM8(m, this.r8(m.reg)); return; }
      case 0x89: { const m = this.decodeModRM(); this.writeRM16(m, this.r16(m.reg)); return; }
      case 0x8A: { const m = this.decodeModRM(); this.w8(m.reg, this.readRM8(m)); return; }
      case 0x8B: { const m = this.decodeModRM(); this.w16(m.reg, this.readRM16(m)); return; }
      case 0x8C: { const m = this.decodeModRM(); this.writeRM16(m, this.sregs[m.reg & 3]); return; }
      case 0x8D: { // LEA
        const m = this.decodeModRM();
        if (m.isReg) throw new EmuError('LEA with register operand');
        this.w16(m.reg, m.off);
        return;
      }
      case 0x8E: { const m = this.decodeModRM(); this.sregs[m.reg & 3] = this.readRM16(m); return; }
      case 0x8F: { const m = this.decodeModRM(); this.writeRM16(m, this.pop16()); return; }
      /* misc 98-9F */
      case 0x98: this.ax = (this.al & 0x80) ? (this.al | 0xFF00) : this.al; return;        // CBW
      case 0x99: this.dx = (this.ax & 0x8000) ? 0xFFFF : 0x0000; return;                   // CWD
      case 0x9A: { // CALL far
        const off = this.fetch16(), seg = this.fetch16();
        this.push16(this.sregs[CS]); this.push16(this.ip);
        this.sregs[CS] = seg; this.ip = off;
        return;
      }
      case 0x9B: return; // WAIT
      case 0x9C: this.push16(this.flags | 0xF000); return;                                  // PUSHF
      case 0x9D: this.flags = (this.pop16() & 0x0FD5) | 0x0002; return;                     // POPF
      case 0x9E: this.flags = (this.flags & 0xFF00) | (this.ah & 0xD5) | 0x02; return;      // SAHF
      case 0x9F: this.w8(4, (this.flags & 0xD5) | 0x02); return;                            // LAHF
      /* MOV acc <-> moffs */
      case 0xA0: this.w8(0, this.read8(this.strSrcSeg(), this.fetch16())); return;
      case 0xA1: this.ax = this.read16(this.strSrcSeg(), this.fetch16()); return;
      case 0xA2: this.write8(this.strSrcSeg(), this.fetch16(), this.al); return;
      case 0xA3: this.write16(this.strSrcSeg(), this.fetch16(), this.ax); return;
      case 0xA8: this.logicFlags(this.al & this.fetch8(), 0); return;
      case 0xA9: this.logicFlags(this.ax & this.fetch16(), 1); return;
      /* RET */
      case 0xC2: { const n = this.fetch16(); this.ip = this.pop16(); this.sp = this.sp + n; return; }
      case 0xC3: this.ip = this.pop16(); return;
      case 0xC4: { // LES
        const m = this.decodeModRM();
        if (m.isReg) throw new EmuError('LES with register operand');
        this.w16(m.reg, this.read16(m.seg, m.off));
        this.sregs[ES] = this.read16(m.seg, m.off + 2);
        return;
      }
      case 0xC5: { // LDS
        const m = this.decodeModRM();
        if (m.isReg) throw new EmuError('LDS with register operand');
        this.w16(m.reg, this.read16(m.seg, m.off));
        this.sregs[DS] = this.read16(m.seg, m.off + 2);
        return;
      }
      case 0xC6: { const m = this.decodeModRM(); this.writeRM8(m, this.fetch8()); return; }
      case 0xC7: { const m = this.decodeModRM(); this.writeRM16(m, this.fetch16()); return; }
      case 0xCA: { const n = this.fetch16(); this.ip = this.pop16(); this.sregs[CS] = this.pop16(); this.sp = this.sp + n; return; }
      case 0xCB: this.ip = this.pop16(); this.sregs[CS] = this.pop16(); return;
      case 0xCC: this.doInt(3, (this.ip - startIP) & 0xFFFF); return;
      case 0xCD: { const n = this.fetch8(); this.doInt(n, (this.ip - startIP) & 0xFFFF); return; }
      case 0xCE: if (this.getF(F_OF)) this.doInt(4, (this.ip - startIP) & 0xFFFF); return;
      case 0xCF: this.ip = this.pop16(); this.sregs[CS] = this.pop16();
                 this.flags = (this.pop16() & 0x0FD5) | 0x0002; return;
      /* shifts */
      case 0xD0: { const m = this.decodeModRM(); this.writeRM8(m, this.shiftOp(m.reg, this.readRM8(m), 1, 0)); return; }
      case 0xD1: { const m = this.decodeModRM(); this.writeRM16(m, this.shiftOp(m.reg, this.readRM16(m), 1, 1)); return; }
      case 0xD2: { const m = this.decodeModRM(); const c = this.r8(1); if (c) this.writeRM8(m, this.shiftOp(m.reg, this.readRM8(m), c, 0)); return; }
      case 0xD3: { const m = this.decodeModRM(); const c = this.r8(1); if (c) this.writeRM16(m, this.shiftOp(m.reg, this.readRM16(m), c, 1)); return; }
      case 0xD4: { // AAM
        const base = this.fetch8();
        if (base === 0) throw new EmuError('AAM divide by zero');
        const al = this.al;
        this.w8(4, Math.floor(al / base)); this.w8(0, al % base);
        this.szp(this.al, 0);
        return;
      }
      case 0xD5: { // AAD
        const base = this.fetch8();
        this.w8(0, (this.al + this.ah * base) & 0xFF); this.w8(4, 0);
        this.szp(this.al, 0);
        return;
      }
      case 0xD7: this.w8(0, this.read8(this.strSrcSeg(), (this.bx + this.al) & 0xFFFF)); return; // XLAT
      /* LOOP / JCXZ */
      case 0xE0: this.cx = this.cx - 1; this.jmpRel8(this.cx !== 0 && !this.getF(F_ZF)); return;
      case 0xE1: this.cx = this.cx - 1; this.jmpRel8(this.cx !== 0 && this.getF(F_ZF)); return;
      case 0xE2: this.cx = this.cx - 1; this.jmpRel8(this.cx !== 0); return;
      case 0xE3: this.jmpRel8(this.cx === 0); return;
      /* IN/OUT (no devices: IN reads 0, OUT is ignored) */
      case 0xE4: this.fetch8(); this.w8(0, 0); return;
      case 0xE5: this.fetch8(); this.ax = 0; return;
      case 0xE6: case 0xE7: this.fetch8(); return;
      case 0xEC: this.w8(0, 0); return;
      case 0xED: this.ax = 0; return;
      case 0xEE: case 0xEF: return;
      /* CALL / JMP */
      case 0xE8: { let d = this.fetch16(); if (d & 0x8000) d -= 0x10000;
                   this.push16(this.ip); this.ip = (this.ip + d) & 0xFFFF; return; }
      case 0xE9: { let d = this.fetch16(); if (d & 0x8000) d -= 0x10000;
                   this.ip = (this.ip + d) & 0xFFFF; return; }
      case 0xEA: { const off = this.fetch16(), seg = this.fetch16();
                   this.sregs[CS] = seg; this.ip = off; return; }
      case 0xEB: this.jmpRel8(true); return;
      case 0xF4: this.halted = true; return;
      case 0xF5: this.setF(F_CF, !this.getF(F_CF)); return;
      /* group 3 */
      case 0xF6: case 0xF7: {
        const w = op & 1;
        const m = this.decodeModRM();
        const read = () => w ? this.readRM16(m) : this.readRM8(m);
        const write = v => w ? this.writeRM16(m, v) : this.writeRM8(m, v);
        const mask = w ? 0xFFFF : 0xFF;
        switch (m.reg) {
          case 0: case 1: { // TEST imm
            const imm = w ? this.fetch16() : this.fetch8();
            this.logicFlags(read() & imm, w);
            return;
          }
          case 2: write((~read()) & mask); return; // NOT (no flags)
          case 3: write(this.sub(0, read(), 0, w)); return; // NEG
          case 4: { // MUL
            if (w) {
              const r = this.ax * read();
              this.ax = r & 0xFFFF; this.dx = (r / 0x10000) | 0;
              const hi = this.dx !== 0;
              this.setF(F_CF, hi); this.setF(F_OF, hi);
            } else {
              const r = this.al * read();
              this.ax = r & 0xFFFF;
              const hi = (r >> 8) !== 0;
              this.setF(F_CF, hi); this.setF(F_OF, hi);
            }
            return;
          }
          case 5: { // IMUL
            const sx = (v, s) => (v & s) ? v - 2 * s : v;
            if (w) {
              const r = sx(this.ax, 0x8000) * sx(read(), 0x8000);
              this.ax = r & 0xFFFF; this.dx = (r >> 16) & 0xFFFF;
              const fit = r >= -32768 && r <= 32767;
              this.setF(F_CF, !fit); this.setF(F_OF, !fit);
            } else {
              const r = sx(this.al, 0x80) * sx(read(), 0x80);
              this.ax = r & 0xFFFF;
              const fit = r >= -128 && r <= 127;
              this.setF(F_CF, !fit); this.setF(F_OF, !fit);
            }
            return;
          }
          case 6: { // DIV
            const d = read();
            if (d === 0) throw new EmuError('division by zero');
            if (w) {
              const n = this.dx * 0x10000 + this.ax;
              const q = Math.floor(n / d);
              if (q > 0xFFFF) throw new EmuError('DIV overflow');
              this.ax = q; this.dx = n % d;
            } else {
              const n = this.ax;
              const q = Math.floor(n / d);
              if (q > 0xFF) throw new EmuError('DIV overflow');
              this.w8(0, q); this.w8(4, n % d);
            }
            return;
          }
          case 7: { // IDIV
            const d0 = read();
            if (d0 === 0) throw new EmuError('division by zero');
            const sx = (v, s) => (v & s) ? v - 2 * s : v;
            if (w) {
              const n2 = ((this.dx << 16) | this.ax) | 0; // signed 32-bit DX:AX
              const d = sx(d0, 0x8000);
              const q = Math.trunc(n2 / d);
              if (q < -32768 || q > 32767) throw new EmuError('IDIV overflow');
              this.ax = q & 0xFFFF; this.dx = (n2 % d) & 0xFFFF;
            } else {
              const n = sx(this.ax, 0x8000);
              const d = sx(d0, 0x80);
              const q = Math.trunc(n / d);
              if (q < -128 || q > 127) throw new EmuError('IDIV overflow');
              this.w8(0, q & 0xFF); this.w8(4, (n % d) & 0xFF);
            }
            return;
          }
        }
        return;
      }
      case 0xF8: this.setF(F_CF, false); return;
      case 0xF9: this.setF(F_CF, true); return;
      case 0xFA: this.setF(F_IF, false); return;
      case 0xFB: this.setF(F_IF, true); return;
      case 0xFC: this.setF(F_DF, false); return;
      case 0xFD: this.setF(F_DF, true); return;
      /* group 4/5 */
      case 0xFE: {
        const m = this.decodeModRM();
        const cf = this.getF(F_CF);
        if (m.reg === 0) this.writeRM8(m, this.add(this.readRM8(m), 1, 0, 0));
        else if (m.reg === 1) this.writeRM8(m, this.sub(this.readRM8(m), 1, 0, 0));
        else throw new EmuError('invalid opcode FE /' + m.reg);
        this.setF(F_CF, cf);
        return;
      }
      case 0xFF: {
        const m = this.decodeModRM();
        switch (m.reg) {
          case 0: { const cf = this.getF(F_CF); this.writeRM16(m, this.add(this.readRM16(m), 1, 0, 1)); this.setF(F_CF, cf); return; }
          case 1: { const cf = this.getF(F_CF); this.writeRM16(m, this.sub(this.readRM16(m), 1, 0, 1)); this.setF(F_CF, cf); return; }
          case 2: { const t = this.readRM16(m); this.push16(this.ip); this.ip = t; return; }
          case 3: { // CALL far m
            if (m.isReg) throw new EmuError('CALL far with register operand');
            const off = this.read16(m.seg, m.off), seg = this.read16(m.seg, m.off + 2);
            this.push16(this.sregs[CS]); this.push16(this.ip);
            this.sregs[CS] = seg; this.ip = off;
            return;
          }
          case 4: this.ip = this.readRM16(m); return;
          case 5: { // JMP far m
            if (m.isReg) throw new EmuError('JMP far with register operand');
            const off = this.read16(m.seg, m.off), seg = this.read16(m.seg, m.off + 2);
            this.sregs[CS] = seg; this.ip = off;
            return;
          }
          case 6: this.push16(this.readRM16(m)); return;
          default: throw new EmuError('invalid opcode FF /' + m.reg);
        }
      }
      case 0xD6: this.w8(0, this.getF(F_CF) ? 0xFF : 0x00); return; // SALC (undocumented)
    }
    /* ESC (8087): consume modrm, treat as NOP */
    if (op >= 0xD8 && op <= 0xDF) { this.decodeModRM(); return; }

    throw new EmuError(`invalid opcode ${op.toString(16).toUpperCase().padStart(2, '0')}h at ${this.sregs[CS].toString(16)}:${startIP.toString(16)}`);
  }
}

/*
 * Minimal DOS environment: handles the common INT 20h/21h services plus
 * INT 10h teletype and INT 16h keyboard, so classic teaching programs run.
 *   output(text)  — called with printable output
 *   inputQueue    — array of char codes; push with pushInput()
 */
function createDOS(output) {
  const state = { inputQueue: [] };

  function readKeyOrWait(cpu, echo) {
    if (!state.inputQueue.length) return 'wait';
    const ch = state.inputQueue.shift();
    cpu.w8(0, ch);
    if (echo) output(String.fromCharCode(ch));
    return true;
  }

  state.hook = function (cpu, n) {
    if (n === 0x20) { cpu.exited = true; cpu.exitCode = 0; return true; }
    if (n === 0x10) {
      const ah = cpu.ah;
      if (ah === 0x0E) output(String.fromCharCode(cpu.al));
      return true; // ignore other video services
    }
    if (n === 0x16) {
      const ah = cpu.ah;
      if (ah === 0x00 || ah === 0x10) {
        if (!state.inputQueue.length) return 'wait';
        cpu.ax = (0 << 8) | state.inputQueue.shift();
        return true;
      }
      if (ah === 0x01 || ah === 0x11) {
        if (state.inputQueue.length) { cpu.setF(F_ZF, false); cpu.ax = state.inputQueue[0]; }
        else cpu.setF(F_ZF, true);
        return true;
      }
      return true;
    }
    if (n !== 0x21) return false;

    const ah = cpu.ah;
    switch (ah) {
      case 0x00: cpu.exited = true; cpu.exitCode = 0; return true;
      case 0x01: return readKeyOrWait(cpu, true);   // read char, echo
      case 0x02: output(String.fromCharCode(cpu.dl)); cpu.w8(0, cpu.dl); return true;
      case 0x06: // direct console I/O
        if (cpu.dl !== 0xFF) { output(String.fromCharCode(cpu.dl)); cpu.w8(0, cpu.dl); return true; }
        if (state.inputQueue.length) { cpu.setF(F_ZF, false); cpu.w8(0, state.inputQueue.shift()); }
        else { cpu.setF(F_ZF, true); cpu.w8(0, 0); }
        return true;
      case 0x07: case 0x08: return readKeyOrWait(cpu, false); // read char, no echo
      case 0x09: { // print '$'-terminated string at DS:DX
        let off = cpu.dx, text = '';
        for (let i = 0; i < 0x10000; i++) {
          const ch = cpu.read8(DS, off);
          if (ch === 0x24) break; // '$'
          text += String.fromCharCode(ch);
          off = (off + 1) & 0xFFFF;
        }
        output(text);
        cpu.w8(0, 0x24);
        return true;
      }
      case 0x0A: { // buffered line input at DS:DX
        const cr = state.inputQueue.indexOf(0x0D);
        if (cr < 0) return 'wait';
        const max = cpu.read8(DS, cpu.dx);
        const line = state.inputQueue.splice(0, cr + 1); // includes CR
        line.pop();
        const stored = line.slice(0, Math.max(0, max - 1));
        cpu.write8(DS, cpu.dx + 1, stored.length);
        for (let i = 0; i < stored.length; i++) cpu.write8(DS, cpu.dx + 2 + i, stored[i]);
        cpu.write8(DS, cpu.dx + 2 + stored.length, 0x0D);
        output(stored.map(c => String.fromCharCode(c)).join('') + '\r\n');
        return true;
      }
      case 0x0B: cpu.w8(0, state.inputQueue.length ? 0xFF : 0x00); return true;
      case 0x4C: cpu.exited = true; cpu.exitCode = cpu.al; return true;
      default:
        throw new EmuError(`unsupported DOS call: INT 21h, AH=${ah.toString(16).toUpperCase().padStart(2, '0')}h`);
    }
  };

  state.pushInput = function (chOrString) {
    if (typeof chOrString === 'string') {
      for (const c of chOrString) state.inputQueue.push(c.charCodeAt(0) & 0xFF);
    } else state.inputQueue.push(chOrString & 0xFF);
  };

  return state;
}

const FLAG_BITS = { CF: F_CF, PF: F_PF, AF: F_AF, ZF: F_ZF, SF: F_SF, TF: F_TF, IF: F_IF, DF: F_DF, OF: F_OF };

const api = { CPU8086, createDOS, EmuError, FLAG_BITS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else global.Emu8086 = api;

})(typeof window !== 'undefined' ? window : globalThis);
