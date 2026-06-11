# 8086 Web Assembler & Emulator

A two-pass 8086 assembler and CPU emulator that run entirely in the browser —
no server, no build step. Just open `index.html` or host the folder on GitHub Pages.

## Features

- **Assembler** — full 8086 base instruction set, all addressing modes,
  segment overrides, `BYTE`/`WORD PTR`, labels, `ORG`, `DB`/`DW` (strings, `DUP`),
  `EQU`, expressions (`+ - * /`, `$`, char literals, `1234h`/`0x1234`/`1010b`)
- **Emulator** — executes the assembled binary on an emulated 8086 with a
  minimal DOS layer (`INT 21h` console I/O and exit, `INT 20h`, `INT 10h` teletype,
  `INT 16h` keyboard)
- **Run tab** — live registers and flags (changes highlighted), Run / Step /
  Reset, and an interactive console for program output and keyboard input
- Listing (address / bytes / source), hex dump, and symbol table views
- Download the result as a `.COM` file (runs in DOSBox)

## Usage

Open `index.html`. The editor assembles as you type; errors appear under the
editor with clickable line numbers. Press **Run** (or step instruction by
instruction) and watch the registers change. Programs that read the keyboard
pause until you click the console and type.

Add `#autorun` to the URL to run the loaded program immediately.

## Development

```
node test.js           # assembler tests (instruction encodings)
node test-emulator.js  # end-to-end tests (assemble + execute + assert)
```

`test-browser.html` is a headless-browser smoke test of the same pipeline.
