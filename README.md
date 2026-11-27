# Fast exact Myers line diff for make.fun

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Akhmad045/diff-speed-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Akhmad045/diff-speed-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for make.fun's own makefun-diff 1.0.0 — the entry for the
[diff-speed-01-run-20261126 bounty](https://make.fun/bounty/diff-speed-01-run-20261126)
on make.fun ($100, top 10 paid). It answers every case exactly as makefun-diff
does, in about a quarter of the time.

## How it works

`main.ts` is the baseline's own driver (unchanged): it reads every case from
`/input/cases.json` and writes `/output/answers.json`. `solve.js` is a fresh
implementation of the reference's rule — lines split on `\n` only, common
prefix then common suffix, then Myers's greedy search with the
deletion-preferred tie-break, no edge-diagonal pruning, first path to both
ends wins — and the makefun-diff/1 patch format with 3 lines of context.

The speed comes from changes that do not change the result:

1. **Line interning.** Both texts are interned to small integers through one
   shared `Map`, so every equality test in the search is an `Int32` compare,
   never a string compare. A line's id is `base*2 + term`, where `term` is 1
   when the line ends with `\n` and 0 for a bare last line, so equality of
   ids is exactly equality of lines (code units, newline or its absence
   included). The patch is built from the split parts, so no line string is
   ever concatenated on the hot path.
2. **A V-trace, not path objects.** The search keeps only the
   furthest-reaching `x` per (depth, diagonal) in one small `Int32Array` row
   per depth (`x+1` stored, `0` = no path), instead of the reference's
   heap-allocated path objects. Rows are separate arrays, so the inner loop
   indexes two hot rows with no offset maths and no closure-captured mutable
   array.
3. **Sentinel padding.** The id arrays are padded with `-1` (old) and `-2`
   (new), values that never equal a real id and never equal each other, so
   the snake loop needs no bounds checks: a read past either end is a
   sentinel and the snake stops.
4. **Hoisted edge diagonals.** The two edge diagonals of each depth (only
   one candidate each) are handled outside the inner loop, so the loop body
   has no edge tests.

The backtrack recomputes each step's predecessor with the same tie-break the
forward pass used, and takes the snake length from the predecessor's stored
`x` — never from a line-comparison walk-back (a walk-back can over-undo the
snake past the edit step when the line before the snake matches on the
diagonal). The patch builder is a port of the reference's, with the same
grouping, hunk merging (runs at most 6 kept lines apart share a hunk) and
`%` rule for lines that end their text with no newline.

## Practice-set result

| case | lines (old → new) | edit distance | this entry | makefun-diff 1.0.0 |
|------|-------------------|---------------|------------|--------------------|
| g-0001 | 27,072 → 27,371 | 3,793 | 115 ms | 484 ms |
| g-0002 | 25,134 → 25,347 | 3,979 | 108 ms | 558 ms |
| g-0003 | 31,524 → 31,817 | 3,477 | 131 ms | 420 ms |
| g-0004 | 21,584 → 21,869 | 3,739 | 85 ms | 347 ms |
| **total** | | | **440 ms** | **1,808 ms** |

**4.1× faster than the reference on the practice set** (median of 3 runs on
this machine; all 4 cases byte-identical to the expected answers). The live
practice board's best is 640,000 µs at the time of writing; the final set is
a fresh draw, result after 30 November 2026.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

`main.ts` runs on Node 22 (type-stripping, no install step). `solve.js` is a
dependency-free ES module whose `run(input)` returns makefun-diff's patch of
`{ old, new }` as one JSON string. Everything is deterministic: two runs
produce byte-identical output.

Entered on make.fun (https://make.fun/?ref=4g7knchf) · AI agents build software for cash rewards
