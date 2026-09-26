# Codex JSONL parse probe (diagnostic experiment)

`experiments/rust-codex-parse/` contains standalone Node and Rust probes. Both
read the same ordered JSON manifest, load each `.jsonl` or `.jsonl.zst` source,
decompress zstd sources, parse every nonblank JSON line, and inspect the record
envelope (`type` and `payload.type`). They print only counts, SHA-256 digests,
wall/CPU timings, and peak process RSS. They do not write to provider data.

The input digest covers each manifest index, source length, and exact source
bytes. The output digest covers each nonblank line's manifest index, line index,
parse status, raw-line SHA-256, `type`, and `payload.type`. Compare `counts`,
`inputSha256`, and `outputSha256` before comparing timings. A mismatch means the
arms did different work. Malformed or non-object JSON lines count as malformed;
both probes continue. The output intentionally omits filenames, session IDs,
record contents, and transcript text.

The generated fixture covers one plain file, one zstd file, CRLF separators,
blank lines, an unterminated final line, and malformed JSON. Both arms reported
2 files, 8 nonblank lines, 6 valid records, and 2 malformed lines, with equal
input and output digests.

On Windows with Node 22.15+ and Cargo installed:

```powershell
Set-Location experiments/rust-codex-parse
node make-fixture.mjs
node probe.mjs --manifest tmp/fixture/manifest.json
cargo run --release -- --manifest tmp/fixture/manifest.json
```

For a real-data run, create one sorted manifest outside provider-owned
directories, then use that same manifest in both commands:

```powershell
node make-manifest.mjs --root 'D:\path\to\codex\sessions' --output tmp/corpus-manifest.json
node probe.mjs --manifest tmp/corpus-manifest.json
.\target\release\codex-parse-probe.exe --manifest tmp/corpus-manifest.json
```

Do not run this alongside the A0/A1 MCP search measurements. Run
each executable as a fresh process, alternate arm order across repetitions,
and label the host cache state. Save only the JSON aggregate output; keep the
manifest private because it names local provider files. `target/` and `tmp/`
are ignored locally. Cargo dependencies live only in this experiment and do
not change the product package.

This is a parser diagnostic, not normalized MCP-result parity or a complete
Node-versus-Rust backend comparison. It measures source read, zstd decode, JSON
parse and envelope hashing in one process, then reads the OS process peak RSS.
Production Codex parsing also handles snapshot consistency, record retention,
normalization, search, and MCP output;
this probe does not measure those stages or startup integration cost. Read,
decompress, and parse timings are instrumented sections; total wall time also
includes hashing, manifest iteration, and RSS inspection.

## Frozen Codex source result, 2026-09-26

The frozen copy contained 840 plain `.jsonl` files, 3,400,267,634 source and
decoded bytes, and 521,451 valid records with zero malformed lines. It had no
`.jsonl.zst` files. All ten runs matched these counts and both digests:

- Input SHA-256: `bec5dd8ab5d29038c28b7555bf1abf48bbbbc612eaafa86555a07bbeef6a6ed7`
- Output SHA-256: `a1a202ac087714256f1e73999685d6b18aeefba2f2c0808df80a075a3a9355fd`

Windows, Node 26.5.1, Rust/Cargo 1.93.1; optimized Rust build. Each run used a
fresh process. Run order was Node/Rust, Rust/Node, Node/Rust, Rust/Node,
Node/Rust. The host cache was not cleared or measured.

| Repetition | Arm | Wall (s) | CPU (s) | Peak RSS (bytes) |
|---:|:---|---:|---:|---:|
| 1 | Node | 13.636 | 13.937 | 1,047,699,456 |
| 1 | Rust | 9.945 | 9.750 | 772,980,736 |
| 2 | Rust | 7.621 | 7.500 | 772,313,088 |
| 2 | Node | 13.470 | 13.875 | 1,048,498,176 |
| 3 | Node | 13.091 | 13.156 | 1,048,473,600 |
| 3 | Rust | 7.655 | 7.563 | 772,276,224 |
| 4 | Rust | 7.610 | 7.531 | 772,317,184 |
| 4 | Node | 13.227 | 13.577 | 1,048,084,480 |
| 5 | Node | 13.203 | 13.391 | 1,029,255,168 |
| 5 | Rust | 7.595 | 7.484 | 772,321,280 |

Nearest-rank p95 over five runs is the maximum observation. Node median/p95
wall was 13.227/13.636 s; Rust was 7.621/9.945 s. Median CPU was
13.577/7.531 s and median peak RSS was 1,048,084,480/772,317,184 bytes
(Node/Rust). Rust's first pass was slower than its later passes, so the host
cache or process warmup may have influenced it. The measured win is confined
to this source-reading and envelope-hashing task.
