'use strict';
/* UI wiring for the 8086 web assembler + emulator. */

const EXAMPLES = {
  'Hello, World (DOS .COM)': `; Hello, World — DOS .COM program
; Press Run to execute it right here in the browser.
org 100h

start:
    mov ah, 09h         ; DOS: print string at DS:DX
    mov dx, msg
    int 21h

    mov ax, 4C00h       ; DOS: exit with code 0
    int 21h

msg: db 'Hello, World!', 0Dh, 0Ah, '$'
`,

  'Sum an array': `; Sum a byte array into AX — watch AX/BX/CX change with Step
org 100h

    xor ax, ax          ; sum = 0
    xor bx, bx          ; index = 0
    mov cx, count

next:
    add al, [array+bx]
    adc ah, 0           ; carry into high byte
    inc bx
    loop next

    mov ax, 4C00h
    int 21h

array: db 10, 20, 30, 40, 50, 250
count equ $ - array
`,

  'Uppercase a string': `; Convert a string to uppercase in place, then print it
org 100h

    mov si, text
fix:
    mov al, [si]
    cmp al, '$'
    je  done
    cmp al, 'a'
    jb  skip
    cmp al, 'z'
    ja  skip
    sub al, 20h         ; 'a'..'z' -> 'A'..'Z'
    mov [si], al
skip:
    inc si
    jmp short fix

done:
    mov ah, 09h
    mov dx, text
    int 21h
    mov ax, 4C00h
    int 21h

text: db 'mixed Case Text!', 0Dh, 0Ah, '$'
`,

  'Keyboard input (echo name)': `; Read a line from the keyboard, then greet.
; Run it, click the console, type your name and press Enter.
org 100h

    mov ah, 09h
    mov dx, prompt
    int 21h

    mov ah, 0Ah         ; DOS: buffered line input
    mov dx, buffer
    int 21h

    ; terminate the typed text with '$'
    mov bl, [buffer+1]  ; number of chars typed
    xor bh, bh
    mov byte [buffer+2+bx], '$'

    mov ah, 09h
    mov dx, hello
    int 21h
    mov ah, 09h
    mov dx, buffer+2
    int 21h
    mov ah, 09h
    mov dx, bang
    int 21h

    mov ax, 4C00h
    int 21h

prompt: db 'What is your name? $'
hello:  db 'Hello, $'
bang:   db '!', 0Dh, 0Ah, '$'
buffer: db 40, 0, 41 dup(0)
`,

  'Multiplication (procedure + stack)': `; Multiply two numbers with a procedure using the stack
org 100h

    mov ax, 7
    mov bx, 6
    call multiply       ; AX = AX * BX
    mov [result], ax

    mov ax, 4C00h
    int 21h

multiply:
    push cx
    push dx
    mul bx              ; DX:AX = AX * BX
    pop dx
    pop cx
    ret

result: dw 0
`,

  'String ops (REP MOVSB)': `; Copy a buffer with REP MOVSB
org 100h

    cld                 ; copy forward
    mov si, source
    mov di, dest
    mov cx, srclen
    rep movsb

    mov ah, 09h
    mov dx, dest
    int 21h
    mov ax, 4C00h
    int 21h

source: db 'copied with movsb', 0Dh, 0Ah, '$'
srclen equ $ - source
dest:   db srclen dup(?)
`,
};

const el = {
  src: document.getElementById('src'),
  highlight: document.getElementById('highlight'),
  gutter: document.getElementById('gutter'),
  errors: document.getElementById('errors'),
  status: document.getElementById('status'),
  examples: document.getElementById('examples'),
  assemble: document.getElementById('btn-assemble'),
  asmRun: document.getElementById('btn-asm-run'),
  download: document.getElementById('btn-download'),
  copy: document.getElementById('btn-copy'),
  listing: document.getElementById('tab-listing'),
  hex: document.getElementById('tab-hex'),
  symbols: document.getElementById('tab-symbols'),
  run: document.getElementById('btn-run'),
  step: document.getElementById('btn-step'),
  reset: document.getElementById('btn-reset'),
  runState: document.getElementById('run-state'),
  regGrid: document.getElementById('reg-grid'),
  flagRow: document.getElementById('flag-row'),
  nextInstr: document.getElementById('next-instr'),
  console: document.getElementById('console'),
};

let lastResult = null;

function hexb(v) { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hexw(v) { return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------------------------------------------- syntax highlighting */

const KEYWORDS = new Set(Assembler8086.KEYWORDS);
const REGISTERS = new Set(Assembler8086.REGISTERS);

function highlightLine(line) {
  // find comment start, ignoring ';' inside string literals
  let commentAt = -1, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; }
    else if (c === "'" || c === '"') q = c;
    else if (c === ';') { commentAt = i; break; }
  }
  const code = commentAt < 0 ? line : line.slice(0, commentAt);
  const comment = commentAt < 0 ? '' : line.slice(commentAt);

  let html = '';
  const re = /([A-Za-z_.@?][A-Za-z0-9_.@?]*)|('[^']*'?|"[^"]*"?)|([0-9][A-Za-z0-9]*)|(\s+)|(.)/g;
  let m;
  while ((m = re.exec(code))) {
    const [text, ident, str, num] = m;
    if (ident) {
      const up = ident.toUpperCase();
      const rest = code.slice(re.lastIndex);
      if (REGISTERS.has(up)) html += `<span class="tok-r">${esc(ident)}</span>`;
      else if (/^[0-9A-F]+H$/.test(up)) html += `<span class="tok-n">${esc(ident)}</span>`;
      else if (KEYWORDS.has(up)) html += `<span class="tok-m">${esc(ident)}</span>`;
      else if (/^\s*:/.test(rest)) html += `<span class="tok-l">${esc(ident)}</span>`;
      else html += esc(ident);
    }
    else if (str) html += `<span class="tok-s">${esc(str)}</span>`;
    else if (num) html += `<span class="tok-n">${esc(num)}</span>`;
    else html += esc(text);
  }
  if (comment) html += `<span class="tok-c">${esc(comment)}</span>`;
  return html;
}

function updateHighlight() {
  el.highlight.innerHTML = el.src.value.split('\n').map(highlightLine).join('\n') + '\n';
  syncScroll();
}

function syncScroll() {
  el.highlight.scrollTop = el.src.scrollTop;
  el.highlight.scrollLeft = el.src.scrollLeft;
  el.gutter.scrollTop = el.src.scrollTop;
}

/* ------------------------------------------------------------- rendering */

function renderGutter(errorLines) {
  const lineCount = el.src.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= lineCount; i++) {
    html += errorLines.has(i) ? `<span class="err-line">${i}</span>\n` : `${i}\n`;
  }
  el.gutter.innerHTML = html;
  el.gutter.scrollTop = el.src.scrollTop;
}

function renderListing(r) {
  let rows = '';
  for (const l of r.listing) {
    const addr = l.addr === null ? '' : hexw(l.addr);
    let bytes = l.bytes.map(hexb).join(' ');
    if (bytes.length > 23) bytes = l.bytes.slice(0, 8).map(hexb).join(' ') + ` … +${l.bytes.length - 8}`;
    rows += `<tr><td class="addr">${addr}</td><td class="bytes">${bytes}</td><td class="src-text">${esc(l.text)}</td></tr>`;
  }
  el.listing.innerHTML = rows
    ? `<table><tr><th>Addr</th><th>Bytes</th><th>Source</th></tr>${rows}</table>`
    : '<span class="dim">Nothing assembled yet.</span>';
}

function renderHex(r) {
  if (!r.bytes.length) {
    el.hex.innerHTML = '<span class="dim">No output bytes.</span>';
    return;
  }
  let out = '';
  for (let i = 0; i < r.bytes.length; i += 16) {
    const chunk = [...r.bytes.slice(i, i + 16)];
    const hexCol = chunk.map(hexb).join(' ').padEnd(47, ' ');
    const ascii = chunk.map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    out += `<span class="addr">${hexw(r.origin + i)}</span>  <span class="bytes">${esc(hexCol)}</span>  <span class="ascii">${esc(ascii)}</span>\n`;
  }
  el.hex.innerHTML = out;
}

function renderSymbols(r) {
  if (!r.symbols.length) {
    el.symbols.innerHTML = '<span class="dim">No symbols defined.</span>';
    return;
  }
  let rows = '';
  for (const s of r.symbols) {
    const v = s.value === undefined ? '????' : hexw(s.value);
    rows += `<tr><td class="src-text">${esc(s.name)}</td><td class="addr">${v}</td><td class="dim">${s.isConst ? 'constant' : 'label'}</td></tr>`;
  }
  el.symbols.innerHTML = `<table><tr><th>Name</th><th>Value</th><th>Kind</th></tr>${rows}</table>`;
}

function renderErrors(r) {
  if (!r.errors.length) {
    el.errors.hidden = true;
    el.errors.innerHTML = '';
    return;
  }
  el.errors.hidden = false;
  el.errors.innerHTML = r.errors
    .map(e => `<div data-line="${e.line}">line ${e.line}: ${esc(e.message)}</div>`)
    .join('');
}

/* -------------------------------------------------------------- assemble */

function doAssemble() {
  const r = Assembler8086.assemble(el.src.value);
  lastResult = r;

  renderGutter(new Set(r.errors.map(e => e.line)));
  renderListing(r);
  renderHex(r);
  renderSymbols(r);
  renderErrors(r);

  el.download.disabled = !r.ok || !r.bytes.length;
  el.copy.disabled = !r.ok || !r.bytes.length;
  el.run.disabled = el.step.disabled = el.reset.disabled = !r.ok || !r.bytes.length;

  if (r.ok) {
    el.status.className = 'ok';
    el.status.textContent = `Assembled OK — ${r.bytes.length} byte${r.bytes.length === 1 ? '' : 's'}, origin ${hexw(r.origin)}h`;
  } else {
    el.status.className = 'err';
    el.status.textContent = `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`;
  }

  machine.needsReload = true;
  if (!machine.loaded) updateRunView();
  else setRunState();
}

function onSourceEdited() {
  updateHighlight();
  renderGutter(new Set()); // line numbers may have shifted; clear stale error marks
  el.status.className = '';
  el.status.textContent = 'Edited — press Assemble or Ctrl+Enter';
}

/* -------------------------------------------------------------- emulator */

const machine = {
  cpu: new Emu8086.CPU8086(),
  dos: null,
  loaded: false,        // a binary is loaded and the CPU state is meaningful
  loadedResult: null,   // the assembly result the CPU is running
  addrMap: new Map(),   // IP offset -> listing entry
  needsReload: true,    // source was re-assembled since last load
  running: false,
  tickTimer: null,
  error: null,
  prev: null,           // previous register snapshot, for change highlighting
};

const REG_VIEW = [
  ['AX', c => c.regs[0]], ['BX', c => c.regs[3]], ['CX', c => c.regs[1]], ['DX', c => c.regs[2]],
  ['SI', c => c.regs[6]], ['DI', c => c.regs[7]], ['BP', c => c.regs[5]], ['SP', c => c.regs[4]],
  ['CS', c => c.sregs[1]], ['DS', c => c.sregs[3]], ['ES', c => c.sregs[0]], ['SS', c => c.sregs[2]],
  ['IP', c => c.ip], ['FLAGS', c => c.flags],
];
const FLAG_VIEW = ['CF', 'ZF', 'SF', 'OF', 'PF', 'AF', 'DF', 'IF', 'TF'];

function consoleWrite(text) {
  for (const ch of text) {
    if (ch === '\r') continue;
    if (ch === '\b' || ch === '\x08') {
      el.console.textContent = el.console.textContent.slice(0, -1);
      continue;
    }
    el.console.textContent += ch;
  }
  el.console.scrollTop = el.console.scrollHeight;
}

function machineLoad() {
  if (!lastResult || !lastResult.ok || !lastResult.bytes.length) return false;
  machine.dos = Emu8086.createDOS(consoleWrite);
  machine.cpu.intHook = machine.dos.hook;
  machine.cpu.load(lastResult.bytes, lastResult.origin);
  machine.loadedResult = lastResult;
  machine.addrMap = new Map();
  for (const l of lastResult.listing) {
    if (l.addr !== null && l.bytes.length && !machine.addrMap.has(l.addr))
      machine.addrMap.set(l.addr, l);
  }
  machine.loaded = true;
  machine.needsReload = false;
  machine.error = null;
  machine.prev = null;
  el.console.textContent = '';
  return true;
}

function ensureLoaded() {
  if (!machine.loaded || machine.needsReload) return machineLoad();
  return true;
}

function machineStopped() {
  const c = machine.cpu;
  return machine.error || c.halted || c.exited;
}

function stepOnce() {
  try {
    machine.cpu.step();
  } catch (e) {
    machine.error = e.message;
    machine.running = false;
  }
}

function runTick() {
  if (!machine.running) return;
  const c = machine.cpu;
  for (let i = 0; i < 30000; i++) {
    stepOnce();
    if (machineStopped() || c.waiting) break;
  }
  if (machineStopped()) machine.running = false;
  updateRunView();
  if (machine.running && !c.waiting) {
    machine.tickTimer = setTimeout(runTick, 0);
  }
  // when waiting for input, the loop resumes from the console key handler
}

function startRun() {
  if (!ensureLoaded()) return;
  if (machineStopped()) machineLoad(); // restart a finished program
  machine.running = true;
  updateRunView();
  el.console.focus({ preventScroll: true });
  runTick();
}

function pauseRun() {
  machine.running = false;
  clearTimeout(machine.tickTimer);
  updateRunView();
}

function setRunState() {
  const c = machine.cpu;
  let cls = '', text;
  if (!machine.loaded) text = lastResult && lastResult.ok ? 'ready — press Run or Step' : 'fix assembly errors first';
  else if (machine.error) { cls = 'error'; text = 'error: ' + machine.error; }
  else if (c.exited) { cls = 'done'; text = `exited (code ${c.exitCode}) — ${c.instrCount.toLocaleString()} instructions`; }
  else if (c.halted) { cls = 'done'; text = `halted (HLT) — ${c.instrCount.toLocaleString()} instructions`; }
  else if (c.waiting) { cls = 'waiting'; text = 'waiting for input — click the console and type'; }
  else if (machine.running) text = `running… ${c.instrCount.toLocaleString()} instructions`;
  else text = `paused — ${c.instrCount.toLocaleString()} instructions`;
  if (machine.loaded && machine.needsReload && !machine.running)
    text += ' · code changed, Run/Reset reloads';
  el.runState.className = cls;
  el.runState.textContent = text;
}

function updateRunView() {
  const c = machine.cpu;
  const snap = REG_VIEW.map(([, get]) => get(c));

  let regHtml = '';
  REG_VIEW.forEach(([name], i) => {
    const changed = machine.prev && machine.prev[i] !== snap[i] ? ' changed' : '';
    regHtml += `<div class="reg${changed}"><span class="rname">${name}</span><span class="rval">${hexw(snap[i])}</span></div>`;
  });
  el.regGrid.innerHTML = regHtml;
  machine.prev = snap;

  let flagHtml = '';
  for (const f of FLAG_VIEW) {
    const on = c.getF(Emu8086.FLAG_BITS[f]);
    flagHtml += `<span class="flag${on ? ' on' : ''}">${f}${on ? 1 : 0}</span>`;
  }
  el.flagRow.innerHTML = flagHtml;

  let next = '';
  if (machine.loaded && !machineStopped()) {
    const entry = machine.addrMap.get(c.ip);
    if (entry) next = `next: <span class="addr">${hexw(c.ip)}</span>  <span class="src-text">${esc(entry.text.trim())}</span>`;
    else next = `next: <span class="addr">${hexw(c.ip)}</span>`;
  }
  el.nextInstr.innerHTML = next;

  el.run.textContent = machine.running ? '❚❚ Pause' : '▶ Run';
  el.run.classList.toggle('running', machine.running);
  setRunState();
}

/* ----------------------------------------------------------------- events */

el.src.addEventListener('input', onSourceEdited);
el.src.addEventListener('scroll', syncScroll);

/* All programmatic edits go through execCommand('insertText') so the
   browser's native undo/redo stack (Ctrl+Z / Ctrl+Y) keeps working. */
function editorInsert(text) {
  if (!document.execCommand('insertText', false, text)) {
    // fallback for browsers without execCommand support (loses undo history)
    const { selectionStart: a, selectionEnd: b, value } = el.src;
    el.src.value = value.slice(0, a) + text + value.slice(b);
    el.src.selectionStart = el.src.selectionEnd = a + text.length;
    onSourceEdited();
  }
}

function editorReplaceRange(start, end, text) {
  el.src.setSelectionRange(start, end);
  editorInsert(text);
}

// Full-line span of the current selection (a selection ending exactly at the
// start of a line does not include that line).
function selectedLineRange() {
  const v = el.src.value;
  const selA = el.src.selectionStart;
  let selB = el.src.selectionEnd;
  if (selB > selA && v[selB - 1] === '\n') selB--;
  const start = v.lastIndexOf('\n', selA - 1) + 1;
  let end = v.indexOf('\n', selB);
  if (end < 0) end = v.length;
  return { start, end };
}

// mode: 'comment' | 'uncomment' | 'toggle'
function setLinesComment(mode) {
  const v = el.src.value;
  const { start, end } = selectedLineRange();
  const lines = v.slice(start, end).split('\n');
  const allComment = lines.filter(l => l.trim()).every(l => /^\s*;/.test(l));
  const comment = mode === 'comment' ? true : mode === 'uncomment' ? false : !allComment;
  const out = lines.map(l => {
    if (!l.trim()) return l;
    if (comment) return /^\s*;/.test(l) && mode === 'comment' ? l : '; ' + l;
    return l.replace(/^(\s*); ?/, '$1');
  }).join('\n');
  if (out === v.slice(start, end)) return;
  editorReplaceRange(start, end, out);
  el.src.setSelectionRange(start, start + out.length);
}

// Ctrl+K chord state (Ctrl+K, C → comment; Ctrl+K, U → uncomment)
let chordPending = false, chordTimer = null;

el.src.addEventListener('keydown', e => {
  const v = el.src.value;
  const selA = el.src.selectionStart, selB = el.src.selectionEnd;
  const ctrl = e.ctrlKey || e.metaKey;

  if (chordPending) {
    if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt')
      return; // modifier press keeps the chord open
    chordPending = false;
    clearTimeout(chordTimer);
    const k = e.key.toLowerCase();
    if (k === 'c') { e.preventDefault(); setLinesComment('comment'); return; }
    if (k === 'u') { e.preventDefault(); setLinesComment('uncomment'); return; }
    // any other key falls through and is handled normally
  }
  if (ctrl && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    chordPending = true;
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => { chordPending = false; }, 2000);
    return;
  }

  if (e.key === 'Enter' && ctrl) { // Ctrl+Enter: assemble; +Shift: also run
    e.preventDefault();
    if (e.shiftKey) assembleAndRun();
    else doAssemble();
    return;
  }

  if (e.key === 'Tab') {                     // indent / unindent
    e.preventDefault();
    if (!e.shiftKey && !v.slice(selA, selB).includes('\n')) {
      editorInsert('    ');
      return;
    }
    const { start, end } = selectedLineRange();
    const out = v.slice(start, end).split('\n')
      .map(l => e.shiftKey ? l.replace(/^(\t| {1,4})/, '') : '    ' + l)
      .join('\n');
    editorReplaceRange(start, end, out);
    el.src.setSelectionRange(start, start + out.length);
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { // auto-indent new line
    e.preventDefault();
    const lineStart = v.lastIndexOf('\n', selA - 1) + 1;
    const indent = v.slice(lineStart, selA).match(/^[ \t]*/)[0];
    editorInsert('\n' + indent);
    return;
  }

  if (ctrl && e.key === '/') {               // Ctrl+/: toggle ; comment
    e.preventDefault();
    setLinesComment('toggle');
    return;
  }

  if (ctrl && (e.key === 'd' || e.key === 'D')) { // Ctrl+D: duplicate line(s)
    e.preventDefault();
    const { start, end } = selectedLineRange();
    const seg = v.slice(start, end);
    editorReplaceRange(end, end, '\n' + seg);
    el.src.setSelectionRange(end + 1, end + 1 + seg.length);
    return;
  }

  if (ctrl && (e.key === 's' || e.key === 'S')) { // Ctrl+S: assemble, not save
    e.preventDefault();
    doAssemble();
    return;
  }
  // Ctrl+Z / Ctrl+Y are intentionally not intercepted: native undo/redo.
});

el.assemble.addEventListener('click', doAssemble);

el.errors.addEventListener('click', e => {
  const line = e.target.dataset.line;
  if (!line) return;
  const lines = el.src.value.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
  el.src.focus();
  el.src.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
});

el.download.addEventListener('click', () => {
  if (!lastResult || !lastResult.ok) return;
  const blob = new Blob([lastResult.bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = lastResult.origin === 0x100 ? 'program.com' : 'program.bin';
  a.click();
  URL.revokeObjectURL(a.href);
});

el.copy.addEventListener('click', async () => {
  if (!lastResult || !lastResult.ok) return;
  const hex = [...lastResult.bytes].map(hexb).join(' ');
  await navigator.clipboard.writeText(hex);
  el.status.textContent = 'Hex copied to clipboard';
});

el.run.addEventListener('click', () => {
  if (machine.running) pauseRun();
  else startRun();
});

el.step.addEventListener('click', () => {
  if (machine.running) pauseRun();
  if (!ensureLoaded()) return;
  if (machineStopped()) machineLoad();
  stepOnce();
  updateRunView();
});

el.reset.addEventListener('click', () => {
  pauseRun();
  machineLoad();
  updateRunView();
});

el.console.addEventListener('keydown', e => {
  if (!machine.loaded || !machine.dos) return;
  let ch = null;
  if (e.key === 'Enter') ch = 0x0D;
  else if (e.key === 'Backspace') ch = 0x08;
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) ch = e.key.charCodeAt(0) & 0xFF;
  if (ch === null) return;
  e.preventDefault();
  machine.dos.pushInput(ch);
  if (machine.cpu.waiting && machine.running) runTick(); // resume
  else if (machine.cpu.waiting && !machine.running) updateRunView();
});

function selectTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  for (const n of ['run', 'listing', 'hex', 'symbols']) {
    document.getElementById('tab-' + n).hidden = n !== name;
  }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

function assembleAndRun() {
  pauseRun();
  doAssemble();
  if (!lastResult || !lastResult.ok || !lastResult.bytes.length) return;
  selectTab('run');
  machineLoad();
  startRun();
}

el.asmRun.addEventListener('click', assembleAndRun);

for (const name of Object.keys(EXAMPLES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  el.examples.appendChild(opt);
}
el.examples.addEventListener('change', () => {
  pauseRun();
  el.src.value = EXAMPLES[el.examples.value];
  machine.loaded = false;
  updateHighlight();
  doAssemble();
  updateRunView();
});

/* ------------------------------------------------------------------ init */

el.src.value = EXAMPLES[Object.keys(EXAMPLES)[0]];
updateHighlight();
doAssemble();
updateRunView();
if (location.hash === '#autorun') startRun(); // run the loaded example immediately
