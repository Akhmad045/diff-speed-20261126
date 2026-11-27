// Fast exact drop-in for makefun-diff 1.0.0 (diff-speed-01-run-20261126).
//
// Re-implements the reference's rule from scratch (its header states it; the
// kit's vendor/makefun-diff/index.js is the spec): lines split on '\n' only,
// common prefix then common suffix, then Myers's greedy search with the
// deletion-preferred tie-break, no edge-diagonal pruning, first path to both
// ends wins, then the makefun-diff/1 patch format with 3 lines of context.
//
// Speed comes from changes that do not change the result:
//  1. Lines are interned to small integers (one shared Map over both texts),
//     so every equality test in the search is an Int32 compare, never a
//     string compare. A line's id is base*2 + term, where term is 1 when the
//     line ends with '\n' and 0 for a bare last line, so equality of ids is
//     exactly equality of lines (code units, newline or its absence included).
//     The patch is built from the split parts, so no line string is ever
//     concatenated on the hot path.
//  2. The search keeps only the furthest-reaching x per (depth, diagonal) in
//     one small Int32Array row per depth (x+1 stored, 0 = no path), instead
//     of the reference's heap-allocated path objects. Rows are separate
//     arrays, so the inner loop indexes two hot rows with no offset maths and
//     no closure-captured mutable array.
//  3. The id arrays are padded with sentinels (-1 in the old text, -2 in the
//     new) that never equal a real id (>= 0) and never equal each other, so
//     the snake loop needs no bounds checks: a read past either end is a
//     sentinel and the snake stops.
//  4. The two edge diagonals of each depth (only one candidate each) are
//     handled outside the inner loop, so the loop body has no edge tests.
// The backtrack recomputes each step's predecessor with the same tie-break
// the forward pass used, and takes the snake length from the predecessor's
// stored x — never from a line-comparison walk-back (a walk-back can
// over-undo the snake past the edit step when the line before the snake
// matches on the diagonal).
//
// The patch builder is a port of the reference's, with the same grouping,
// hunk merging (runs at most 2*CONTEXT kept lines apart share a hunk) and
// '%' rule for lines that end their text with no newline.

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
export const CONTEXT = 3;

/** Run kinds, internal. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** One case's answer: makefun-diff 1.0.0's patch of input { old, new }. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldParts = input.old.split('\n');
  const newParts = input.new.split('\n');
  const oldLast = oldParts.length - 1;
  const newLast = newParts.length - 1;
  const n = oldLast + (oldParts[oldLast] !== '' ? 1 : 0);
  const m = newLast + (newParts[newLast] !== '' ? 1 : 0);

  // Intern both texts into one id space: id = base*2 + term.
  const map = new Map();
  let nextId = 0;
  const A = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = oldParts[i];
    let id = map.get(s);
    if (id === undefined) { id = nextId++; map.set(s, id); }
    A[i] = id * 2 + (i < oldLast ? 1 : 0);
  }
  const B = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    const s = newParts[j];
    let id = map.get(s);
    if (id === undefined) { id = nextId++; map.set(s, id); }
    B[j] = id * 2 + (j < newLast ? 1 : 0);
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...myersRuns(A.subarray(prefix, n - suffix), B.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  return buildPatch(oldParts, newParts, oldLast, newLast, n, m, runs);
}

// ---------------------------------------------------------------- Myers's search

/** The runs of the edit script of A0 into B0: [{ kind, count }], in order. */
function myersRuns(A0, B0) {
  const n = A0.length;
  const m = B0.length;
  // Pad with sentinels so the snake loop needs no bounds checks: a read past
  // either end sees -1 (old) or -2 (new), never a real id (>= 0) and never
  // each other. A snake's y can reach 2n+m, so the pad covers that.
  const L = 2 * n + m + 2;
  const A = new Int32Array(L);
  A.set(A0);
  A.fill(-1, n);
  const B = new Int32Array(L);
  B.set(B0);
  B.fill(-2, m);

  // rows[d] is an Int32Array(d+1) holding x+1 for k = -d, -d+2, ..., d at
  // index (k+d)/2; 0 means no path on that diagonal.
  const rows = [];
  let prev = new Int32Array(1);
  let x0 = 0;
  while (A[x0] === B[x0]) x0++;
  prev[0] = x0 + 1;
  rows.push(prev);
  if (x0 === n && x0 === m) return [];

  let D = -1;
  let kEnd = 0;
  for (let d = 1; d <= n + m; d++) {
    const cur = new Int32Array(d + 1);
    let done = false;
    // idx = 0 (k = -d): insertion candidate only, from prev[0].
    {
      const pv = prev[0];
      if (pv > 0 && pv + d - 2 < m) {
        let x = pv - 1;
        let y = x + d;
        while (A[x] === B[y]) { x++; y++; }
        cur[0] = x + 1;
        if (x === n && y === m) { D = d; kEnd = -d; done = true; }
      }
    }
    if (!done) {
      for (let idx = 1; idx < d; idx++) {
        const k = 2 * idx - d;
        // Deletion candidate: diagonal k-1 at depth d-1, one old line further.
        // Stored v means x = v-1, so the deletion's pre-snake x is v itself.
        let delX = -1;
        const pdel = prev[idx - 1];
        if (pdel > 0 && pdel - 1 < n) delX = pdel;
        // Insertion candidate: diagonal k+1 at depth d-1, one new line
        // further; its pre-snake x is the predecessor's x.
        let insX = -1;
        const pins = prev[idx];
        if (pins > 0 && pins - (k + 1) - 1 < m) insX = pins - 1;
        if (delX < 0 && insX < 0) continue; // cur[idx] stays 0: no path
        // The candidate further into the old text, and the deletion on a tie.
        let x = delX >= insX ? delX : insX;
        let y = x - k;
        while (A[x] === B[y]) { x++; y++; }
        cur[idx] = x + 1;
        if (x === n && y === m) { D = d; kEnd = k; done = true; break; }
      }
    }
    if (!done) {
      // idx = d (k = d): deletion candidate only, from prev[d-1].
      const pv = prev[d - 1];
      if (pv > 0 && pv - 1 < n) {
        let x = pv;
        let y = x - d;
        while (A[x] === B[y]) { x++; y++; }
        cur[d] = x + 1;
        if (x === n && y === m) { D = d; kEnd = d; done = true; }
      }
    }
    rows.push(cur);
    if (done) break;
    prev = cur;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (D, kEnd): at each depth the step's predecessor is the
  // same winner the forward pass took, and the snake length is x minus the
  // winner's pre-snake x.
  const steps = [];
  let d = D;
  let k = kEnd;
  let x = rows[D][(D + kEnd) / 2] - 1;
  while (d > 0) {
    const pr = rows[d - 1];
    const idx = (k + d) / 2;
    let delX = -1;
    if (idx >= 1) {
      const v = pr[idx - 1];
      if (v > 0 && v - 1 < n) delX = v;
    }
    let insX = -1;
    if (idx <= d - 1) {
      const v = pr[idx];
      if (v > 0 && v - (k + 1) - 1 < m) insX = v - 1;
    }
    if (delX < 0 && insX < 0) throw new Error('makefun-diff: backtrack lost its path');
    if (delX >= insX) {
      if (x > delX) steps.push({ kind: KEEP, count: x - delX });
      steps.push({ kind: DELETE, count: 1 });
      x = pr[idx - 1] - 1;
      k = k - 1;
    } else {
      if (x > insX) steps.push({ kind: KEEP, count: x - insX });
      steps.push({ kind: INSERT, count: 1 });
      x = pr[idx] - 1;
      k = k + 1;
    }
    d--;
  }
  if (x > 0) steps.push({ kind: KEEP, count: x }); // the depth-0 snake
  const runs = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === s.kind) last.count += s.count;
    else runs.push({ kind: s.kind, count: s.count });
  }
  return runs;
}

// ---------------------------------------------------------------- the patch

/** A line as the patch writes it: op, the line, a newline, and '%' on a line of its own when it had none. */
function written(op, part, term) {
  return term ? `${op}${part}\n` : `${op}${part}\n%\n`;
}

/** make.fun's own patch of the two texts, from their parts and the runs. */
function buildPatch(oldParts, newParts, oldLast, newLast, n, m, runs) {
  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', oldParts[at], at < oldLast ? 1 : 0));
      for (let i = 0; i < c.dels; i++) out.push(written('-', oldParts[c.o + i], c.o + i < oldLast ? 1 : 0));
      for (let i = 0; i < c.ins; i++) out.push(written('+', newParts[c.p + i], c.p + i < newLast ? 1 : 0));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', oldParts[at], at < oldLast ? 1 : 0));
  }
  return out.join('');
}
