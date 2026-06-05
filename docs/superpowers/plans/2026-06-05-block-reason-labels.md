# Block-Reason Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label Google-Calendar block events by reason/source (no lock emoji) and add context in the description.

**Architecture:** Extend the pure `google-calendar-blocks.ts`: a `blockLabel(blockType, provider)` helper drives titles, `buildBlockSpans` splits on `block_type` change, and `buildBlockEvent` gains a `provider` arg + a context description. The sync job just passes `property.provider` through.

**Tech Stack:** TypeScript (ESM `.js` imports), googleapis (calendar_v3), Vitest. Spec: `docs/superpowers/specs/2026-06-05-block-reason-labels-design.md`.

**Conventions:** ESM `.js` imports; `npx vitest run <path>`; ESLint `no-unused-vars` enforced; end green (tsc + suite).

---

## Task 1: Reason-based block labels + context

**Files:**
- Modify: `src/services/google-calendar-blocks.ts`
- Modify: `src/services/google-calendar-blocks.test.ts`
- Modify: `src/jobs/sync-google-calendar.ts` (pass `provider`)

- [ ] **Step 1: Update the test file**

Replace the `describe('buildBlockEvent', ...)` block in `src/services/google-calendar-blocks.test.ts` with the following, and ADD the new `blockLabel` import + a span-split test. Concretely:

Change the import line to:
```typescript
import { buildBlockSpans, buildBlockEvent, blockEventId, blockLabel } from './google-calendar-blocks.js';
```

Add this test inside `describe('buildBlockSpans', ...)`:
```typescript
  it('splits spans when block_type changes on consecutive days', () => {
    const spans = buildBlockSpans([
      { date: '2026-06-04', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-05', status: 'blocked', block_type: 'manual' },
    ]);
    expect(spans).toEqual([
      { startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'owner' },
      { startDate: '2026-06-05', endExclusive: '2026-06-06', blockType: 'manual' },
    ]);
  });
```

Add a new `describe` for `blockLabel`:
```typescript
describe('blockLabel', () => {
  it('labels by reason, falls back to provider, no lock emoji', () => {
    expect(blockLabel('owner', 'guesty')).toBe('Owner-Block');
    expect(blockLabel('maintenance', 'guesty')).toBe('Wartung');
    expect(blockLabel('manual', 'guesty')).toBe('Manuell blockiert');
    expect(blockLabel(null, 'hostex')).toBe('Blockiert (Hostex)');
    expect(blockLabel(null, 'airbnb-mail')).toBe('Blockiert (Airbnb)');
    expect(blockLabel(null, 'guesty')).toBe('Blockiert');
    expect(blockLabel('owner', 'guesty')).not.toContain('🔒');
  });
});
```

Replace the entire existing `describe('buildBlockEvent', ...)` block with:
```typescript
describe('buildBlockEvent', () => {
  it('titles by reason (no lock emoji), with context description + cleanup marker', () => {
    const ev = buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-08', blockType: 'owner' }, 'Bootshaus', 'hostex');
    expect(ev.summary).toBe('Owner-Block');           // reason wins over provider
    expect(ev.summary).not.toContain('🔒');
    expect(ev.start).toEqual({ date: '2026-06-04' });
    expect(ev.end).toEqual({ date: '2026-06-08' });
    expect(ev.location).toBe('Bootshaus');
    expect(ev.transparency).toBe('opaque');
    expect(ev.extendedProperties?.private?.kind).toBe('owner-block');
    expect(ev.description).toContain('Quelle: Hostex');
    expect(ev.description).toContain('4 Nächte');
    expect(ev.description).toContain('04.06.');
    expect(ev.description).toContain('08.06.');
  });

  it('falls back to provider-based title when block_type is null; pluralises 1 Nacht', () => {
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X', 'hostex').summary).toBe('Blockiert (Hostex)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'manual' }, 'X', 'guesty').summary).toBe('Manuell blockiert');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X', 'guesty').description).toContain('1 Nacht');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/google-calendar-blocks.test.ts`
Expected: FAIL — `blockLabel` not exported; `buildBlockEvent` 3rd arg / no-emoji / description not yet implemented; span-split not yet implemented.

- [ ] **Step 3: Implement in `src/services/google-calendar-blocks.ts`**

(a) Add a millisecond constant + day-diff helper near `addOneDay` (top of file, after `addOneDay`):
```typescript
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function nightsBetween(startDate: string, endExclusive: string): number {
  return Math.round((new Date(`${endExclusive}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / MS_PER_DAY);
}

/** German DD.MM. for a YYYY-MM-DD date. */
function ddmm(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}.`;
}
```

(b) In `buildBlockSpans`, tighten the merge condition so spans split on `block_type` change. Replace:
```typescript
    if (last && last.endExclusive === day.date) {
      last.endExclusive = addOneDay(day.date); // extend contiguous span
    } else {
```
with:
```typescript
    if (last && last.endExclusive === day.date && last.blockType === day.block_type) {
      last.endExclusive = addOneDay(day.date); // extend contiguous same-reason span
    } else {
```

(c) Delete the `BLOCK_TITLES` const and add the exported `blockLabel` + a provider-label map:
```typescript
const PROVIDER_LABELS: Record<string, string> = {
  guesty: 'Guesty',
  hostex: 'Hostex',
  'airbnb-mail': 'Airbnb',
};

/** Best available block reason/source label (no emoji). */
export function blockLabel(blockType: string | null, provider: string): string {
  if (blockType === 'owner') return 'Owner-Block';
  if (blockType === 'maintenance') return 'Wartung';
  if (blockType === 'manual') return 'Manuell blockiert';
  if (provider === 'hostex') return 'Blockiert (Hostex)';
  if (provider === 'airbnb-mail') return 'Blockiert (Airbnb)';
  return 'Blockiert';
}
```

(d) Replace `buildBlockEvent` with the provider-aware version (title via `blockLabel`, context description):
```typescript
/** Build an all-day Google Calendar event for a blocked span. */
export function buildBlockEvent(span: BlockSpan, propertyName: string, provider: string): calendar_v3.Schema$Event {
  const nights = nightsBetween(span.startDate, span.endExclusive);
  const source = PROVIDER_LABELS[provider] ?? provider;
  return {
    summary: blockLabel(span.blockType, provider),
    description: `Quelle: ${source} · ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} · ${ddmm(span.startDate)}–${ddmm(span.endExclusive)}`,
    location: propertyName,
    start: { date: span.startDate },
    end: { date: span.endExclusive },
    transparency: 'opaque',
    extendedProperties: { private: { kind: 'owner-block' } },
  };
}
```

- [ ] **Step 4: Pass `provider` from the sync job**

In `src/jobs/sync-google-calendar.ts`, the block upsert calls `buildBlockEvent(span, name)`. Change it to:
```typescript
        await googleCalendarClient.upsertEvent(calendarId, blockEventId(listingId, span.startDate), buildBlockEvent(span, name, property.provider));
```
(`property` is the function parameter of `syncGoogleCalendarForProperty`; `property.provider` exists on `PropertyConfig`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/google-calendar-blocks.test.ts`
Expected: PASS (all, incl. new cases).

- [ ] **Step 6: Full green + lint**

Run: `npx tsc --noEmit` (clean), `npx vitest run` (full suite passes), `npx eslint src/services/google-calendar-blocks.ts src/services/google-calendar-blocks.test.ts src/jobs/sync-google-calendar.ts` (0 errors).

- [ ] **Step 7: Commit**

```bash
git add src/services/google-calendar-blocks.ts src/services/google-calendar-blocks.test.ts src/jobs/sync-google-calendar.ts
git commit -m "feat(blocks): reason/source labels for Google Calendar block events (no lock emoji)"
```

---

## Task 2: Verify

- [ ] **Step 1:** `npx vitest run` (all pass) · `npx tsc --noEmit` (clean) · `npm run build` (clean) · `npx eslint "src/**/*.ts"` (0 errors).

---

## Self-Review Notes (author)

- **Spec coverage:** `blockLabel` table (all rows, no emoji) — Task 1 Step 3c + tests; span split on `block_type` change — Step 3b + test; `provider` passthrough + description context — Step 3d/Step 4 + tests. All spec sections mapped.
- **Type consistency:** `buildBlockEvent(span, propertyName, provider)` 3-arg signature used in both the test and the sync job; `blockLabel(blockType, provider)` consistent; `BlockSpan` unchanged.
- **YAGNI:** no guessed reasons, no Hostex→owner assumption (stays "Blockiert (Hostex)").
- **Green per commit:** the `buildBlockEvent` signature change + the sync-job call update land in the same task, so tsc stays green.
