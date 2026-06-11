// End-to-end tests: assemble source, run it on the emulated 8086,
// then assert on registers, flags, memory, and console output.
'use strict';
const { assemble } = require('./assembler.js');
const { CPU8086, createDOS, FLAG_BITS } = require('./emulator.js');

let passCount = 0, failCount = 0;

function run(source, { input = '', maxInstr = 1_000_000 } = {}) {
  const r = assemble(source);
  if (!r.ok) throw new Error('assembly failed: ' + r.errors.map(e => `L${e.line}: ${e.message}`).join('; '));
  const cpu = new CPU8086();
  let out = '';
  const dos = createDOS(t => { out += t; });
  dos.pushInput(input);
  cpu.intHook = dos.hook;
  cpu.load(r.bytes, r.origin);
  while (!cpu.halted && !cpu.exited && !cpu.waiting) {
    cpu.step();
    if (cpu.instrCount > maxInstr) throw new Error('instruction budget exceeded (infinite loop?)');
  }
  return { cpu, out };
}

function check(name, source, asserts, opts) {
  try {
    const { cpu, out } = run(source, opts);
    const fails = [];
    for (const [what, expected] of Object.entries(asserts)) {
      let got;
      if (what === 'out') got = out;
      else if (what === 'ax') got = cpu.ax;
      else if (what === 'bx') got = cpu.bx;
      else if (what === 'cx') got = cpu.cx;
      else if (what === 'dx') got = cpu.dx;
      else if (what === 'sp') got = cpu.sp;
      else if (what === 'si') got = cpu.regs[6];
      else if (what === 'di') got = cpu.regs[7];
      else if (what === 'exit') got = cpu.exitCode;
      else if (what in FLAG_BITS) got = cpu.getF(FLAG_BITS[what]) ? 1 : 0;
      else if (what.startsWith('mem:')) got = cpu.read16(3, parseInt(what.slice(4), 16));
      else throw new Error('unknown assert ' + what);
      if (got !== expected) fails.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
    if (fails.length) {
      failCount++;
      console.log(`FAIL ${name}\n  ${fails.join('\n  ')}`);
    } else passCount++;
  } catch (e) {
    failCount++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const EXIT = '\nmov ax, 4C00h\nint 21h\n';

/* ---- arithmetic & flags ---- */
check('add basic', 'mov ax, 5\nadd ax, 7\nhlt', { ax: 12, ZF: 0, CF: 0, SF: 0 });
check('add carry', 'mov ax, 0FFFFh\nadd ax, 1\nhlt', { ax: 0, ZF: 1, CF: 1 });
check('add overflow', 'mov ax, 7FFFh\nadd ax, 1\nhlt', { ax: 0x8000, OF: 1, SF: 1, CF: 0 });
check('sub borrow', 'mov al, 1\nsub al, 2\nhlt', { ax: 0x00FF, CF: 1, SF: 1 });
check('adc chain', 'mov ax, 0FFFFh\nmov bx, 0\nadd ax, 1\nadc bx, 0\nhlt', { ax: 0, bx: 1 });
check('sbb', 'mov ax, 10\nstc\nsbb ax, 3\nhlt', { ax: 6 });
check('cmp flags', 'mov ax, 5\ncmp ax, 5\nhlt', { ax: 5, ZF: 1, CF: 0 });
check('neg', 'mov ax, 5\nneg ax\nhlt', { ax: 0xFFFB, CF: 1, SF: 1 });
check('inc keeps CF', 'stc\nmov ax, 1\ninc ax\nhlt', { ax: 2, CF: 1 });
check('mul 8', 'mov al, 12\nmov bl, 12\nmul bl\nhlt', { ax: 144 });
check('mul 16', 'mov ax, 1234h\nmov bx, 100h\nmul bx\nhlt', { ax: 0x3400, dx: 0x0012, CF: 1 });
check('imul neg', 'mov al, -5\nmov bl, 3\nimul bl\nhlt', { ax: (-15) & 0xFFFF });
check('div', 'mov ax, 145\nmov bl, 12\ndiv bl\nhlt', { ax: (1 << 8) | 12 }); // AL=12 quot, AH=1 rem
check('div 16', 'mov dx, 1\nmov ax, 0\nmov bx, 2\ndiv bx\nhlt', { ax: 0x8000, dx: 0 });
check('idiv', 'mov ax, -15\ncwd\nmov bx, 4\nidiv bx\nhlt', { ax: (-3) & 0xFFFF, dx: (-3) & 0xFFFF });

/* ---- logic / shifts ---- */
check('and/or/xor', 'mov al, 0F0h\nand al, 3Ch\nhlt', { ax: 0x30, CF: 0 });
check('xor self', 'mov ax, 1234h\nxor ax, ax\nhlt', { ax: 0, ZF: 1 });
check('shl', 'mov al, 81h\nshl al, 1\nhlt', { ax: 0x02, CF: 1 });
check('shr', 'mov al, 3\nshr al, 1\nhlt', { ax: 1, CF: 1 });
check('sar neg', 'mov al, -8\nsar al, 1\nhlt', { ax: (-4) & 0xFF });
check('shift by cl', 'mov ax, 1\nmov cl, 4\nshl ax, cl\nhlt', { ax: 16 });
check('rol', 'mov al, 81h\nrol al, 1\nhlt', { ax: 0x03, CF: 1 });
check('rcl through carry', 'stc\nmov al, 0\nrcl al, 1\nhlt', { ax: 1 });
check('not', 'mov ax, 0F0F0h\nnot ax\nhlt', { ax: 0x0F0F });
check('test', 'mov al, 5\ntest al, 4\nhlt', { ax: 5, ZF: 0 });

/* ---- data movement / memory ---- */
check('mov mem', 'org 100h\nmov ax, 1234h\nmov [x], ax\nmov bx, [x]\nhlt\nx: dw 0', { bx: 0x1234 });
check('indexed', 'org 100h\nmov bx, tab\nmov si, 2\nmov al, [bx+si]\nhlt\ntab: db 10,20,30,40', { ax: 30 });
check('lea', 'org 100h\nlea bx, [data+2]\nhlt\ndata: dw 1,2,3', { bx: 0x100 + 5 + 2 }); // lea(4)+hlt(1)
check('xchg', 'mov ax, 1\nmov bx, 2\nxchg ax, bx\nhlt', { ax: 2, bx: 1 });
check('xlat', 'org 100h\nmov bx, tab\nmov al, 2\nxlat\nhlt\ntab: db 5,6,7,8', { ax: 7 });
check('cbw/cwd', 'mov al, -2\ncbw\ncwd\nhlt', { ax: 0xFFFE, dx: 0xFFFF });

/* ---- stack / calls ---- */
check('push pop', 'mov ax, 1234h\npush ax\nmov ax, 0\npop bx\nhlt', { bx: 0x1234, sp: 0xFFFE });
check('call ret', 'call f\nhlt\nf: mov ax, 99\nret', { ax: 99 });
check('nested calls', 'call a\nhlt\na: call b\ninc ax\nret\nb: mov ax, 10\nret', { ax: 11 });
check('pushf/popf', 'stc\npushf\nclc\npopf\nhlt', { CF: 1 });
check('ret n', 'push ax\npush ax\ncall f\nhlt\nf: ret 4'.replace('push ax\npush ax\ncall f', 'mov ax,1\npush ax\npush ax\ncall f'),
      { sp: 0xFFFE });

/* ---- control flow ---- */
check('loop sums', 'xor ax, ax\nmov cx, 10\nl: add ax, cx\nloop l\nhlt', { ax: 55, cx: 0 });
check('jcc taken', 'mov ax, 5\ncmp ax, 5\nje y\nmov bx, 1\nhlt\ny: mov bx, 2\nhlt', { bx: 2 });
check('jg signed', 'mov ax, -1\ncmp ax, 1\njg y\nmov bx, 1\nhlt\ny: mov bx, 2\nhlt', { bx: 1 });
check('ja unsigned', 'mov ax, -1\ncmp ax, 1\nja y\nmov bx, 1\nhlt\ny: mov bx, 2\nhlt', { bx: 2 });
check('jcxz', 'mov cx, 0\njcxz y\nmov bx, 1\nhlt\ny: mov bx, 2\nhlt', { bx: 2 });
check('jmp indirect', 'mov bx, t\njmp bx\nhlt\nt: mov ax, 7\nhlt', { ax: 7 });

/* ---- string ops ---- */
check('rep movsb', [
  'org 100h',
  'cld', 'mov si, src', 'mov di, dst', 'mov cx, 4', 'rep movsb',
  'mov ax, [dst]', 'hlt',
  'src: db 11h, 22h, 33h, 44h',
  'dst: db 4 dup(0)',
].join('\n'), { ax: 0x2211, cx: 0 });
check('rep stosw', [
  'org 100h',
  'cld', 'mov di, buf', 'mov ax, 0ABCDh', 'mov cx, 3', 'rep stosw',
  'mov bx, [buf+4]', 'hlt',
  'buf: dw 3 dup(0)',
].join('\n'), { bx: 0xABCD });
check('repne scasb', [
  'org 100h',
  'cld', 'mov di, s', 'mov al, "C"', 'mov cx, 5', 'repne scasb',
  'hlt',
  's: db "ABCDE"',
].join('\n'), { ZF: 1, cx: 2 });

/* ---- DOS console ---- */
check('hello world', [
  'org 100h',
  'mov ah, 09h', 'mov dx, msg', 'int 21h',
  'mov ax, 4C00h', 'int 21h',
  "msg: db 'Hello!$'",
].join('\n'), { out: 'Hello!', exit: 0 });
check('char out', 'mov ah, 02h\nmov dl, 41h\nint 21h' + EXIT, { out: 'A' });
check('exit code', 'mov ax, 4C07h\nint 21h', { exit: 7 });
check('echo input', 'mov ah, 01h\nint 21h\nmov ah, 02h\nmov dl, al\nint 21h' + EXIT,
      { out: 'kk' }, { input: 'k' });
check('uppercase example', [
  'org 100h',
  '    mov si, text',
  'fix:',
  '    mov al, [si]',
  "    cmp al, '$'",
  '    je  done',
  "    cmp al, 'a'",
  '    jb  skip',
  "    cmp al, 'z'",
  '    ja  skip',
  '    sub al, 20h',
  '    mov [si], al',
  'skip:',
  '    inc si',
  '    jmp short fix',
  'done:',
  '    mov ah, 09h',
  '    mov dx, text',
  '    int 21h',
  '    mov ax, 4C00h',
  '    int 21h',
  "text: db 'aBc!$'",
].join('\n'), { out: 'ABC!' });

check('buffered line input', [
  'org 100h',
  'mov ah, 0Ah', 'mov dx, buffer', 'int 21h',
  'mov bl, [buffer+1]', 'xor bh, bh',
  "mov byte [buffer+2+bx], '$'",
  'mov ah, 09h', 'mov dx, buffer+2', 'int 21h',
  'mov ax, 4C00h', 'int 21h',
  'buffer: db 40, 0, 41 dup(0)',
].join('\n'), { out: 'Bob\r\nBob' }, { input: 'Bob\r' });

/* ---- BCD ---- */
check('daa', 'mov al, 15h\nadd al, 27h\ndaa\nhlt', { ax: 0x42 });
check('aam', 'mov al, 45\naam\nhlt', { ax: (4 << 8) | 5 });
check('aad', 'mov ax, 0405h\naad\nhlt', { ax: 45 });

/* ---- segment override + seg regs ---- */
check('seg regs', 'mov ax, cs\nmov ds, ax\nmov bx, ds\nhlt', {});
check('plain ret exits', 'org 100h\nmov ax, 1\nret', { exit: 0 }); // CP/M-style: RET hits INT 20h stub

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
