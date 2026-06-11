// Assembles every example program from app.js and reports errors.
'use strict';
const fs = require('fs');
const { assemble } = require('./assembler.js');

const src = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const m = src.match(/const EXAMPLES = (\{[\s\S]*?\n\});/);
if (!m) { console.error('could not locate EXAMPLES in app.js'); process.exit(1); }
const EXAMPLES = eval('(' + m[1] + ')');

let bad = 0;
for (const [name, code] of Object.entries(EXAMPLES)) {
  const r = assemble(code);
  if (r.ok) {
    console.log(`OK   ${name} — ${r.bytes.length} bytes`);
  } else {
    bad++;
    console.log(`FAIL ${name}`);
    for (const e of r.errors) console.log(`     line ${e.line}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
