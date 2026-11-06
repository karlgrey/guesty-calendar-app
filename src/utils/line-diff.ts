// #1062: Kompakter Zeilen-Diff im unified-Format (ohne ---/+++-Header, 1 Kontextzeile), für
// /auto-send/decisions (Entwurf vs. gesendeter Text). Bewusst ohne npm-Dependency: Gäste-
// nachrichten sind kurz, ein LCS über Zeilen reicht. Für sehr lange Texte (n*m > MAX_CELLS)
// fällt der Diff auf "alles raus, alles rein" zurück, statt Speicher zu sprengen.

const CONTEXT = 1;
const MAX_CELLS = 4_000_000;

type Op = { kind: ' ' | '-' | '+'; line: string; aIdx: number; bIdx: number };

function splitLines(s: string): string[] {
  return s.replace(/\r\n?/g, '\n').split('\n');
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const ops: Op[] = [];
  if (n * m > MAX_CELLS) {
    a.forEach((line, i) => ops.push({ kind: '-', line, aIdx: i, bIdx: 0 }));
    b.forEach((line, j) => ops.push({ kind: '+', line, aIdx: n, bIdx: j }));
    return ops;
  }
  // lcs[i][j] = Länge der LCS von a[i..] und b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i], aIdx: i, bIdx: j }); i++; j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] > lcs[i + 1][j])) {
      ops.push({ kind: '+', line: b[j], aIdx: i, bIdx: j }); j++;
    } else {
      ops.push({ kind: '-', line: a[i], aIdx: i, bIdx: j }); i++;
    }
  }
  return ops;
}

/** Unified-Zeilen-Diff von `before` nach `after`; leerer String, wenn identisch. */
export function unifiedLineDiff(before: string, after: string): string {
  const ops = diffOps(splitLines(before), splitLines(after));
  const changed = ops.map((o, k) => (o.kind !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (changed.length === 0) return '';

  // Änderungsbereiche um CONTEXT erweitern und überlappende/angrenzende zusammenführen.
  const ranges: Array<[number, number]> = [];
  for (const k of changed) {
    const start = Math.max(0, k - CONTEXT);
    const end = Math.min(ops.length - 1, k + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = (aCount ? slice.find((o) => o.kind !== '+')!.aIdx : slice[0].aIdx) + (aCount ? 1 : 0);
    const bStart = (bCount ? slice.find((o) => o.kind !== '-')!.bIdx : slice[0].bIdx) + (bCount ? 1 : 0);
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
  }
  return out.join('\n');
}
