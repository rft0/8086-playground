// Node test suite for the 8086 assembler.
// Expected byte sequences hand-verified against the Intel 8086 opcode map.
'use strict';
const { assemble } = require('./assembler.js');

let passCount = 0, failCount = 0;

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function check(name, source, expectedHex) {
  const r = assemble(source);
  if (!r.ok) {
    failCount++;
    console.log(`FAIL ${name}: assembly errors: ${r.errors.map(e => `L${e.line}: ${e.message}`).join('; ')}`);
    return;
  }
  const got = hex(r.bytes);
  if (got === expectedHex.toUpperCase()) { passCount++; return; }
  failCount++;
  console.log(`FAIL ${name}\n  source:   ${source.replace(/\n/g, ' | ')}\n  expected: ${expectedHex.toUpperCase()}\n  got:      ${got}`);
}

function checkError(name, source, msgPart) {
  const r = assemble(source);
  if (r.ok) {
    failCount++;
    console.log(`FAIL ${name}: expected an error containing "${msgPart}", but assembly succeeded (${hex(r.bytes)})`);
    return;
  }
  if (msgPart && !r.errors.some(e => e.message.toLowerCase().includes(msgPart.toLowerCase()))) {
    failCount++;
    console.log(`FAIL ${name}: expected error containing "${msgPart}", got: ${r.errors.map(e => e.message).join('; ')}`);
    return;
  }
  passCount++;
}

/* ---- MOV ---- */
check('mov r8,imm',      'mov ah, 09h',        'B4 09');
check('mov r16,imm',     'mov ax, 4C00h',      'B8 00 4C');
check('mov r16,r16',     'mov ax, bx',         '89 D8');
check('mov r8,r8',       'mov al, bh',         '88 F8');
check('mov r8,mem',      'mov al, [bx+si+5]',  '8A 40 05');
check('mov mem,r8',      'mov [di], al',       '88 05');
check('mov r16,direct',  'mov ax, [1234h]',    '8B 06 34 12');
check('mov mem,imm b',   'mov byte [bx], 7',   'C6 07 07');
check('mov mem,imm w',   'mov word [si], 300', 'C7 04 2C 01');
check('mov sreg,r16',    'mov es, ax',         '8E C0');
check('mov r16,sreg',    'mov ax, cs',         '8C C8');
check('mov bp disp0',    'mov [bp], ax',       '89 46 00');
check('mov seg ovr',     'mov ax, es:[di]',    '26 8B 05');
check('mov neg imm',     'mov al, -1',         'B0 FF');

/* ---- ALU group ---- */
check('add r16,r16',     'add ax, bx',         '01 D8');
check('add acc8,imm',    'add al, 5',          '04 05');
check('add acc16,imm',   'add ax, 1000h',      '05 00 10');
check('add r8,imm',      'add bl, 5',          '80 C3 05');
check('add r16,imm s8',  'add bx, 5',          '83 C3 05');
check('add r16,imm 16',  'add bx, 300',        '81 C3 2C 01');
check('sub mem,imm',     'sub word [bx], 5',   '83 2F 05');
check('cmp acc,imm',     'cmp ax, 1000h',      '3D 00 10');
check('xor zero',        'xor ax, ax',         '31 C0');
check('and r8,mem',      'and cl, [bx]',       '22 0F');
check('or mem,r16',      'or [si], dx',        '09 14');
check('adc/sbb',         'adc ax, bx\nsbb cx, dx', '11 D8 19 D1');

/* ---- INC/DEC/NEG/NOT/MUL/DIV ---- */
check('inc r16',         'inc ax',             '40');
check('dec r16',         'dec cx',             '49');
check('inc r8',          'inc al',             'FE C0');
check('inc mem byte',    'inc byte [bx]',      'FE 07');
check('dec mem word',    'dec word [di]',      'FF 0D');
check('not mem',         'not byte [bx+1]',    'F6 57 01');
check('neg r16',         'neg ax',             'F7 D8');
check('mul r8',          'mul bl',             'F6 E3');
check('imul r16',        'imul cx',            'F7 E9');
check('div mem',         'div word [si]',      'F7 34');

/* ---- shifts ---- */
check('shl 1',           'shl ax, 1',          'D1 E0');
check('shr cl',          'shr bl, cl',         'D2 EB');
check('sar 1',           'sar ax, 1',          'D1 F8');
check('rol/ror/rcl/rcr', 'rol al,1\nror al,1\nrcl al,1\nrcr al,1', 'D0 C0 D0 C8 D0 D0 D0 D8');
checkError('shift by 3', 'shl ax, 3', 'shift/rotate by 1 or by CL');

/* ---- stack ---- */
check('push/pop r16',    'push ax\npop bx',    '50 5B');
check('push/pop sreg',   'push ds\npop es',    '1E 07');
check('push mem',        'push word [bx]',     'FF 37');
check('pop mem',         'pop word [si]',      '8F 04');
checkError('pop cs',     'pop cs', 'not allowed');
checkError('push imm',   'push 5', 'no PUSH immediate');

/* ---- TEST / XCHG / LEA ---- */
check('test acc,imm',    'test al, 1',         'A8 01');
check('test r,r',        'test bx, cx',        '85 CB');
check('test mem,imm',    'test byte [bx], 80h','F6 07 80');
check('xchg ax,r16',     'xchg ax, bx',        '93');
check('xchg r8,mem',     'xchg bl, [si]',      '86 1C');
check('lea',             'lea bx, [bp+2]',     '8D 5E 02');

/* ---- jumps / calls / loops ---- */
check('jmp fwd',         'jmp x\nnop\nx: hlt', 'E9 01 00 90 F4');
check('jmp short back',  'x: nop\njmp short x','90 EB FD');
check('jmp reg',         'jmp bx',             'FF E3');
check('je fwd',          'je x\nnop\nx: hlt',  '74 01 90 F4');
check('jne back',        'x: nop\njne x',      '90 75 FD');
check('loop',            'x: nop\nloop x',     '90 E2 FD');
check('jcxz',            'x: nop\njcxz x',     '90 E3 FD');
check('call/ret',        'call f\nhlt\nf: ret','E8 01 00 F4 C3');
check('ret imm',         'ret 4',              'C2 04 00');
checkError('jcc too far', 'je x\ndb 200 dup(0)\nx: nop', 'out of range');

/* ---- INT / IO / strings / misc ---- */
check('int',             'int 21h',            'CD 21');
check('in/out',          'in al, 60h\nin ax, dx\nout dx, al\nout 20h, al', 'E4 60 ED EE E6 20');
check('rep movsb',       'rep movsb',          'F3 A4');
check('repne scasb',     'repne scasb',        'F2 AE');
check('string ops',      'lodsb\nstosw\ncmpsb\nscasw\nmovsw', 'AC AB A6 AF A5');
check('flags',           'clc\nstc\ncld\nstd\ncli\nsti\ncmc', 'F8 F9 FC FD FA FB F5');
check('misc',            'nop\nhlt\ncbw\ncwd\nxlat\npushf\npopf\niret', '90 F4 98 99 D7 9C 9D CF');
check('aam/aad',         'aam\naad',           'D4 0A D5 0A');

/* ---- data / directives / symbols ---- */
check('db basics',       "db 'AB', 0, 255, -1",         '41 42 00 FF FF');
check('db dup',          'db 3 dup(7)',                 '07 07 07');
check('db dup ?',        'db 2 dup(?)',                 '00 00');
check('dw values',       'dw 1234h, 5',                 '34 12 05 00');
check('dw label',        'org 100h\nx: dw x',           '00 01');
check('equ',             'five equ 5\nmov al, five',    'B0 05');
check('equ expr',        'n equ 2+3*4\nmov al, n',      'B0 0E');
check('len via $',       "org 100h\nmsg db 'hi'\nlen equ $-msg\nmov cx, len", '68 69 B9 02 00');
check('char literal',    "mov al, 'A'",                 'B0 41');
check('hex 0x',          'mov ax, 0x1234',              'B8 34 12');
check('binary',          'mov al, 1010b',               'B0 0A');
checkError('dup symbol',  'x: nop\nx: nop', 'duplicate');
checkError('undef sym',   'mov ax, nowhere', 'undefined symbol');
checkError('size needed', 'mov [bx], 5', 'BYTE PTR or WORD PTR');
checkError('bad addr reg','mov al, [ax]', 'not valid in an 8086 address');
checkError('imm range',   'mov al, 300', 'out of range');

/* ---- full program: DOS hello world ---- */
check('hello world', [
  'org 100h',
  'start:',
  '    mov ah, 09h',
  '    mov dx, msg',
  '    int 21h',
  '    mov ax, 4C00h',
  '    int 21h',
  "msg: db 'Hi!$'",
].join('\n'), 'B4 09 BA 0C 01 CD 21 B8 00 4C CD 21 48 69 21 24');

/* ---- forward references keep two-pass sizes stable ---- */
check('fwd mem ref', [
  'org 100h',
  'mov ax, [data]',
  'mov [data], ax',
  'hlt',
  'data: dw 0',
].join('\n'), '8B 06 09 01 89 06 09 01 F4 00 00');

/* ---- comments and labels ---- */
check('comments', "mov al, ';' ; this ; is a comment\nnop", 'B0 3B 90');
check('label only line', 'x:\nnop\njmp x', '90 E9 FC FF');

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
