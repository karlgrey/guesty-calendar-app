# Agent-API: Reservierung + Angebot — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API-Key-geschützte Agent-Endpoints (+ Admin-Formular), die für Direktanfragen einen Gast + Hold-Reservierung in Guesty anlegen und das Angebots-PDF mit fortlaufender Nummer erzeugen (Spec: `docs/superpowers/specs/2026-07-24-agent-reservierung-design.md`).

**Architecture:** Neue Write-Methoden im bestehenden `GuestyClient` (Singleton, Bottleneck-Limiter) → neuer Orchestrierungs-Service `reservation-service` → neue Route `/api/agent/*` mit Key-Middleware + Formular unter `/admin`. Angebots-PDF über den bestehenden `document-service` (`documentType: 'quote'`). Hold = Guesty-Status `reserved` mit `reservedUntil: -1`; die fachliche Frist `holdUntil` lebt nur in der Antwort/Doku und wird von Claude überwacht (kein Scheduler).

**Tech Stack:** Node ≥18, TypeScript ESM (Imports MIT `.js`-Suffix!), Express 4, better-sqlite3, Vitest 2, Zod-Env-Config.

## Global Constraints

- **ESM:** alle relativen Imports mit `.js`-Endung (`from '../utils/errors.js'`).
- **Keine neuen npm-Dependencies.**
- `DocumentType` ist `'quote' | 'invoice'` — Angebot = `'quote'`.
- Fehlerklassen aus `src/utils/errors.ts` (`ValidationError`, `NotFoundError`, `ExternalApiError`); für Belegungskonflikte wird dort eine neue `ConflictError` (409) ergänzt (Task 3).
- Nur Guesty-Objekte: `propertySlug` muss in `data/properties.json` existieren UND `provider === 'guesty'` haben (heute: `farmhouse`, `u19`).
- Logging via `logger` (`src/utils/logger.js`), niemals den API-Key loggen.
- Tests: `npx vitest run <datei>` (Env-Stubs kommen aus `vitest.config.ts`).
- Nach jedem Task committen (Repo `guesty-calendar-app`, Branch `main`).

---

### Task 1: Env-Config `agentApiKey` + Middleware `requireAgentKey`

**Files:**
- Modify: `src/config/index.ts` (Zod-Schema ~Zeile 23ff + env-Mapping ~Zeile 128ff)
- Create: `src/middleware/agent-key.ts`
- Test: `src/middleware/agent-key.test.ts`

**Interfaces:**
- Consumes: `config` aus `src/config/index.js`
- Produces: `config.agentApiKey?: string` · `requireAgentKey(req, res, next)` (Express-Middleware; 503 wenn kein Key konfiguriert, 401 bei fehlendem/falschem Header `X-Agent-Key`, sonst `next()`)

- [ ] **Step 1: Failing Test schreiben**

```ts
// src/middleware/agent-key.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// config mocken, damit wir den Key pro Test steuern können
vi.mock('../config/index.js', () => ({ config: { agentApiKey: undefined as string | undefined } }));

import { config } from '../config/index.js';
import { requireAgentKey } from './agent-key.js';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('requireAgentKey', () => {
  beforeEach(() => { (config as any).agentApiKey = undefined; });

  it('503 wenn kein Key konfiguriert', () => {
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 bei fehlendem Header', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('401 bei falschem Key', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'wrong' : undefined) } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('next() bei korrektem Key', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'secret-key-123' : undefined) } as any, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/middleware/agent-key.test.ts`
Expected: FAIL („Cannot find module … agent-key.js")

- [ ] **Step 3: Config erweitern**

In `src/config/index.ts` im `configSchema` (bei den anderen optionalen Keys, z. B. nach `vaultPath`):

```ts
  agentApiKey: z.string().min(32, 'AGENT_API_KEY must be at least 32 characters').optional(),
```

Im env-Mapping-Objekt (bei `process.env.*`, ~Zeile 128ff):

```ts
    agentApiKey: process.env.AGENT_API_KEY,
```

- [ ] **Step 4: Middleware implementieren**

```ts
// src/middleware/agent-key.ts
/**
 * Agent-API Key Middleware
 *
 * Schützt /api/agent/* mit einem statischen Key (Header X-Agent-Key).
 * Ohne konfigurierten AGENT_API_KEY ist die Agent-API deaktiviert (503).
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export function requireAgentKey(req: Request, res: Response, next: NextFunction) {
  const expected = config.agentApiKey;
  if (!expected) {
    return res.status(503).json({ error: 'Agent API is not configured' });
  }

  const provided = req.header('X-Agent-Key');
  if (!provided || provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    logger.warn({ path: req.path, ip: req.ip }, 'Agent API: invalid or missing key');
    return res.status(401).json({ error: 'Invalid agent key' });
  }

  next();
}
```

- [ ] **Step 5: Tests laufen lassen — müssen grün sein**

Run: `npx vitest run src/middleware/agent-key.test.ts`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/middleware/agent-key.ts src/middleware/agent-key.test.ts
git commit -m "feat(agent-api): AGENT_API_KEY config + requireAgentKey middleware"
```

---

### Task 2: GuestyClient — Write-Methoden

**Files:**
- Modify: `src/services/guesty-client.ts` (neue Methoden hinter `sendConversationMessage`, ~Zeile 758)
- Test: `src/services/guesty-client.writes.test.ts`

**Interfaces:**
- Consumes: `private request<T>(endpoint, options)` (bestehend, geht durch Limiter+Auth)
- Produces (auf der Klasse `GuestyClient` + damit dem Singleton `guestyClient`):
  - `createGuest(g: { firstName: string; lastName: string; email: string; phone?: string }): Promise<string>` — Rückgabe Guest-ID
  - `createReservation(p: { listingId: string; checkIn: string; checkOut: string; guestsCount: number; guestId: string; status: 'reserved' | 'confirmed' | 'inquiry'; accommodationFare?: number; cleaningFee?: number }): Promise<string>` — Rückgabe Reservation-ID
  - `updateReservationStatus(reservationId: string, status: 'confirmed' | 'canceled'): Promise<void>`

- [ ] **Step 1: Failing Tests schreiben**

```ts
// src/services/guesty-client.writes.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GuestyClient } from './guesty-client.js';

function clientWithMockedRequest(result: any) {
  const client = new GuestyClient();
  const spy = vi.spyOn(client as any, 'request').mockResolvedValue(result);
  return { client, spy };
}

describe('GuestyClient writes', () => {
  it('createGuest POSTet an /guests-crud und liefert die ID', async () => {
    const { client, spy } = clientWithMockedRequest({ _id: 'guest-1' });
    const id = await client.createGuest({ firstName: 'Nina', lastName: 'Lattke', email: 'n@x.de', phone: '+49 170 000' });
    expect(id).toBe('guest-1');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/guests-crud');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ firstName: 'Nina', lastName: 'Lattke', email: 'n@x.de', phones: ['+49 170 000'] });
  });

  it('createReservation POSTet an /reservations-v3 mit reservedUntil -1 und Preis-Override', async () => {
    const { client, spy } = clientWithMockedRequest({ _id: 'res-1' });
    const id = await client.createReservation({
      listingId: 'listing-1', checkIn: '2026-09-09', checkOut: '2026-09-10',
      guestsCount: 15, guestId: 'guest-1', status: 'reserved', accommodationFare: 2850,
    });
    expect(id).toBe('res-1');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      listingId: 'listing-1',
      checkInDateLocalized: '2026-09-09',
      checkOutDateLocalized: '2026-09-10',
      guestsCount: 15,
      guestId: 'guest-1',
      status: 'reserved',
      source: 'manual',
      reservedUntil: -1,
      accommodationFare: 2850,
    });
    expect(body).not.toHaveProperty('cleaningFee');
  });

  it('createReservation lässt accommodationFare weg, wenn kein Preis übergeben', async () => {
    const { client, spy } = clientWithMockedRequest({ _id: 'res-2' });
    await client.createReservation({
      listingId: 'l', checkIn: '2026-09-09', checkOut: '2026-09-10',
      guestsCount: 2, guestId: 'g', status: 'reserved',
    });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('accommodationFare');
  });

  it('updateReservationStatus PUTtet an /reservations-v3/{id}/status', async () => {
    const { client, spy } = clientWithMockedRequest({ ok: true });
    await client.updateReservationStatus('res-1', 'canceled');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3/res-1/status');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ status: 'canceled' });
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/services/guesty-client.writes.test.ts`
Expected: FAIL („createGuest is not a function")

- [ ] **Step 3: Methoden implementieren**

In `src/services/guesty-client.ts`, direkt nach `sendConversationMessage(...)` einfügen:

```ts
  /**
   * Create a guest record (guests-crud).
   * Returns the new guest's ID.
   */
  async createGuest(g: { firstName: string; lastName: string; email: string; phone?: string }): Promise<string> {
    const res = await this.request<any>('/guests-crud', {
      method: 'POST',
      body: JSON.stringify({
        firstName: g.firstName,
        lastName: g.lastName,
        email: g.email,
        ...(g.phone ? { phones: [g.phone] } : {}),
      }),
    });
    const id = res?._id ?? res?.id ?? res?.data?._id;
    if (typeof id !== 'string') {
      throw new ExternalApiError('Guesty createGuest response missing id', 502, 'Guesty', { res });
    }
    logger.info({ guestId: id }, 'Created Guesty guest');
    return id;
  }

  /**
   * Create a reservation via Reservations V3 quick booking.
   * Hold = status 'reserved' with reservedUntil -1 (no Guesty auto-expiry;
   * the hold deadline is managed outside the app, see agent-reservierung spec).
   * accommodationFare overrides the calculated nightly rates (flat offer price).
   */
  async createReservation(p: {
    listingId: string;
    checkIn: string;
    checkOut: string;
    guestsCount: number;
    guestId: string;
    status: 'reserved' | 'confirmed' | 'inquiry';
    accommodationFare?: number;
    cleaningFee?: number;
  }): Promise<string> {
    const res = await this.request<any>('/reservations-v3', {
      method: 'POST',
      body: JSON.stringify({
        listingId: p.listingId,
        checkInDateLocalized: p.checkIn,
        checkOutDateLocalized: p.checkOut,
        guestsCount: p.guestsCount,
        guestId: p.guestId,
        status: p.status,
        source: 'manual',
        reservedUntil: -1,
        ...(p.accommodationFare !== undefined ? { accommodationFare: p.accommodationFare } : {}),
        ...(p.cleaningFee !== undefined ? { cleaningFee: p.cleaningFee } : {}),
      }),
    });
    const id = res?._id ?? res?.id ?? res?.data?._id;
    if (typeof id !== 'string') {
      throw new ExternalApiError('Guesty createReservation response missing id', 502, 'Guesty', { res });
    }
    logger.info({ reservationId: id, listingId: p.listingId, status: p.status }, 'Created Guesty reservation');
    return id;
  }

  /**
   * Update a reservation's status (confirm a hold / cancel it).
   */
  async updateReservationStatus(reservationId: string, status: 'confirmed' | 'canceled'): Promise<void> {
    await this.request<any>(`/reservations-v3/${reservationId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    logger.info({ reservationId, status }, 'Updated Guesty reservation status');
  }
```

Prüfen, dass `ExternalApiError` bereits importiert ist (wird von `getQuote` genutzt); falls nicht: zum Import aus `../utils/errors.js` hinzufügen.

- [ ] **Step 4: Tests laufen lassen — müssen grün sein**

Run: `npx vitest run src/services/guesty-client.writes.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/guesty-client.ts src/services/guesty-client.writes.test.ts
git commit -m "feat(agent-api): GuestyClient write methods (createGuest, createReservation, updateReservationStatus)"
```

---

### Task 3: `reservation-service` — Orchestrierung

**Files:**
- Modify: `src/utils/errors.ts` (neue Klasse `ConflictError`)
- Create: `src/services/reservation-service.ts`
- Test: `src/services/reservation-service.test.ts`

**Interfaces:**
- Consumes: `guestyClient` (Singleton, Task-2-Methoden + `getQuote`), `areDatesAvailable(listingId, checkIn, checkOut)` aus `../repositories/availability-repository.js`, `createOrGetDocument({ reservationId, documentType })` aus `./document-service.js`, `getPropertyBySlug(slug)` aus `../config/properties.js`
- Produces:

```ts
export interface CreateOfferInput {
  propertySlug: string;
  checkIn: string;   // YYYY-MM-DD
  checkOut: string;  // YYYY-MM-DD
  guestsCount: number;
  guest: { firstName: string; lastName: string; email: string; phone?: string };
  priceGross?: number;   // Pauschale in EUR (accommodationFare-Override)
  cleaningFee?: number;  // EUR
  holdUntil?: string;    // YYYY-MM-DD, Default heute+14 Tage
}

export interface CreateOfferResult {
  reservationId: string;
  guestId: string;
  documentNumber: string;
  holdUntil: string;
  priceSource: 'manual' | 'quote';
  documentError?: string; // gesetzt, wenn Reservierung ok, aber PDF/Nummer fehlschlug
}

export async function createOfferReservation(input: CreateOfferInput): Promise<CreateOfferResult>
export async function confirmOfferReservation(reservationId: string): Promise<void>
export async function releaseOfferReservation(reservationId: string): Promise<void>
```

- [ ] **Step 1: `ConflictError` ergänzen**

In `src/utils/errors.ts` nach `ValidationError`:

```ts
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, details);
    this.name = 'ConflictError';
  }
}
```

(Signatur an die bestehenden Klassen anpassen — `ValidationError` als Vorlage nehmen und exakt deren Konstruktor-Form kopieren.)

- [ ] **Step 2: Failing Tests schreiben**

```ts
// src/services/reservation-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: {
    createGuest: vi.fn().mockResolvedValue('guest-1'),
    createReservation: vi.fn().mockResolvedValue('res-1'),
    updateReservationStatus: vi.fn().mockResolvedValue(undefined),
    getQuote: vi.fn().mockResolvedValue({ money: { totalPrice: 1200 } }),
  },
}));
vi.mock('../repositories/availability-repository.js', () => ({
  areDatesAvailable: vi.fn().mockReturnValue(true),
}));
vi.mock('./document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('pdf'), isNew: true,
  }),
}));
vi.mock('../config/properties.js', () => ({
  getPropertyBySlug: vi.fn((slug: string) =>
    slug === 'farmhouse'
      ? { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'listing-fh' }
      : slug === 'firenze-loft'
        ? { slug: 'firenze-loft', provider: 'airbnb-mail' }
        : undefined),
}));

import { guestyClient } from './guesty-client.js';
import { areDatesAvailable } from '../repositories/availability-repository.js';
import { createOrGetDocument } from './document-service.js';
import { createOfferReservation, confirmOfferReservation, releaseOfferReservation } from './reservation-service.js';

const baseInput = {
  propertySlug: 'farmhouse',
  checkIn: '2026-09-09',
  checkOut: '2026-09-10',
  guestsCount: 15,
  guest: { firstName: 'Nina', lastName: 'Lattke', email: 'n@x.de' },
  priceGross: 2850,
};

beforeEach(() => { vi.clearAllMocks(); (areDatesAvailable as any).mockReturnValue(true); });

describe('createOfferReservation', () => {
  it('legt Gast + Hold an und erzeugt das Angebot', async () => {
    const r = await createOfferReservation({ ...baseInput });
    expect(guestyClient.createGuest).toHaveBeenCalledOnce();
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.objectContaining({
      listingId: 'listing-fh', status: 'reserved', accommodationFare: 2850,
    }));
    expect(createOrGetDocument).toHaveBeenCalledWith({ reservationId: 'res-1', documentType: 'quote' });
    expect(r).toMatchObject({ reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042', priceSource: 'manual' });
  });

  it('409 bei belegtem Zeitraum — KEIN Guesty-Call', async () => {
    (areDatesAvailable as any).mockReturnValue(false);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(/not available|belegt/i);
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('validiert: unbekanntes Objekt, Nicht-Guesty-Objekt, checkOut<=checkIn, guestsCount<1, Preis<=0', async () => {
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'nope' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'firenze-loft' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, checkOut: '2026-09-09' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, guestsCount: 0 })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, priceGross: -1 })).rejects.toThrow();
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('ohne priceGross: kein Override, priceSource=quote', async () => {
    const { priceGross: _p, ...noPrice } = baseInput;
    const r = await createOfferReservation(noPrice as any);
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.not.objectContaining({ accommodationFare: expect.anything() }));
    expect(r.priceSource).toBe('quote');
  });

  it('holdUntil Default = heute + 14 Tage', async () => {
    const r = await createOfferReservation({ ...baseInput });
    const expected = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(r.holdUntil).toBe(expected);
  });

  it('Teilfehler: Dokument schlägt fehl → Reservierung bleibt, documentError gesetzt', async () => {
    (createOrGetDocument as any).mockRejectedValue(new Error('pdf kaputt'));
    const r = await createOfferReservation({ ...baseInput });
    expect(r.reservationId).toBe('res-1');
    expect(r.documentError).toMatch(/pdf kaputt/);
    expect(guestyClient.updateReservationStatus).not.toHaveBeenCalled(); // NICHT stornieren
  });
});

describe('confirm/release', () => {
  it('confirm setzt Status confirmed', async () => {
    await confirmOfferReservation('res-1');
    expect(guestyClient.updateReservationStatus).toHaveBeenCalledWith('res-1', 'confirmed');
  });
  it('release setzt Status canceled', async () => {
    await releaseOfferReservation('res-1');
    expect(guestyClient.updateReservationStatus).toHaveBeenCalledWith('res-1', 'canceled');
  });
});
```

- [ ] **Step 3: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/services/reservation-service.test.ts`
Expected: FAIL („Cannot find module … reservation-service.js")

- [ ] **Step 4: Service implementieren**

```ts
// src/services/reservation-service.ts
/**
 * Reservation Service — Angebots-Workflow für Direktanfragen (Agent-API + Admin-Form).
 *
 * Erstellt Gast + Hold-Reservierung (status 'reserved', reservedUntil -1) in Guesty
 * und erzeugt das Angebots-PDF über den bestehenden document-service.
 * Reihenfolge bewusst: erst Reservierung, dann Dokument — so wird nie eine
 * Angebotsnummer verbrannt, wenn Guesty ablehnt. Schlägt umgekehrt das Dokument
 * fehl, bleibt die Reservierung stehen (documentError in der Antwort; Angebot
 * lässt sich über den Admin-Flow nachziehen).
 *
 * Spec: docs/superpowers/specs/2026-07-24-agent-reservierung-design.md
 */
import { guestyClient } from './guesty-client.js';
import { createOrGetDocument } from './document-service.js';
import { areDatesAvailable } from '../repositories/availability-repository.js';
import { getPropertyBySlug } from '../config/properties.js';
import { ValidationError, ConflictError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface CreateOfferInput {
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  guestsCount: number;
  guest: { firstName: string; lastName: string; email: string; phone?: string };
  priceGross?: number;
  cleaningFee?: number;
  holdUntil?: string;
}

export interface CreateOfferResult {
  reservationId: string;
  guestId: string;
  documentNumber: string;
  holdUntil: string;
  priceSource: 'manual' | 'quote';
  documentError?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOLD_DEFAULT_DAYS = 14;

function validate(input: CreateOfferInput): { listingId: string } {
  const prop = getPropertyBySlug(input.propertySlug);
  if (!prop) throw new ValidationError(`Unknown property: ${input.propertySlug}`);
  if (prop.provider !== 'guesty' || !prop.guestyPropertyId) {
    throw new ValidationError(`Property ${input.propertySlug} is not a Guesty property`);
  }
  if (!DATE_RE.test(input.checkIn) || !DATE_RE.test(input.checkOut)) {
    throw new ValidationError('checkIn/checkOut must be YYYY-MM-DD');
  }
  if (input.checkOut <= input.checkIn) throw new ValidationError('checkOut must be after checkIn');
  if (!Number.isInteger(input.guestsCount) || input.guestsCount < 1) {
    throw new ValidationError('guestsCount must be a positive integer');
  }
  if (!input.guest?.firstName || !input.guest?.lastName || !input.guest?.email) {
    throw new ValidationError('guest.firstName, guest.lastName and guest.email are required');
  }
  if (input.priceGross !== undefined && !(input.priceGross > 0)) {
    throw new ValidationError('priceGross must be > 0');
  }
  if (input.cleaningFee !== undefined && !(input.cleaningFee >= 0)) {
    throw new ValidationError('cleaningFee must be >= 0');
  }
  if (input.holdUntil !== undefined && !DATE_RE.test(input.holdUntil)) {
    throw new ValidationError('holdUntil must be YYYY-MM-DD');
  }
  return { listingId: prop.guestyPropertyId };
}

export async function createOfferReservation(input: CreateOfferInput): Promise<CreateOfferResult> {
  const { listingId } = validate(input);

  // Lokaler Verfügbarkeits-Check (schnelles 409); Guesty prüft beim Anlegen
  // nochmal autoritativ (ignoreCalendar bleibt false).
  if (!areDatesAvailable(listingId, input.checkIn, input.checkOut)) {
    throw new ConflictError(`Dates not available: ${input.checkIn}..${input.checkOut}`);
  }

  const holdUntil = input.holdUntil
    ?? new Date(Date.now() + HOLD_DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const guestId = await guestyClient.createGuest(input.guest);
  const reservationId = await guestyClient.createReservation({
    listingId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guestsCount: input.guestsCount,
    guestId,
    status: 'reserved',
    ...(input.priceGross !== undefined ? { accommodationFare: input.priceGross } : {}),
    ...(input.cleaningFee !== undefined ? { cleaningFee: input.cleaningFee } : {}),
  });

  const result: CreateOfferResult = {
    reservationId,
    guestId,
    documentNumber: '',
    holdUntil,
    priceSource: input.priceGross !== undefined ? 'manual' : 'quote',
  };

  try {
    const doc = await createOrGetDocument({ reservationId, documentType: 'quote' });
    result.documentNumber = doc.document.documentNumber;
  } catch (err) {
    // Reservierung NICHT stornieren — Angebot kann über den Admin-Flow nachgezogen werden.
    result.documentError = err instanceof Error ? err.message : String(err);
    logger.error({ err, reservationId }, 'Offer document creation failed after reservation was created');
  }

  logger.info({ reservationId, guestId, holdUntil, priceSource: result.priceSource }, 'Offer reservation created');
  return result;
}

export async function confirmOfferReservation(reservationId: string): Promise<void> {
  await guestyClient.updateReservationStatus(reservationId, 'confirmed');
}

export async function releaseOfferReservation(reservationId: string): Promise<void> {
  await guestyClient.updateReservationStatus(reservationId, 'canceled');
}
```

Hinweis: falls das `documentNumber`-Feld im `Document`-Typ anders heißt (prüfen in `src/repositories/document-repository.ts`, z. B. `document_number`), Feldzugriff UND Test-Mock anpassen — maßgeblich ist der echte Typ.

- [ ] **Step 5: Tests laufen lassen — müssen grün sein**

Run: `npx vitest run src/services/reservation-service.test.ts`
Expected: alle Tests passed

- [ ] **Step 6: Commit**

```bash
git add src/utils/errors.ts src/services/reservation-service.ts src/services/reservation-service.test.ts
git commit -m "feat(agent-api): reservation-service (Hold + Angebot, Konflikt-409, Teilfehler-Handling)"
```

---

### Task 4: Route `/api/agent/*`

**Files:**
- Create: `src/routes/agent-api.ts`
- Modify: `src/app.ts` (Import + Mount vor den `/admin`-Mounts)
- Test: `src/routes/agent-api.test.ts`

**Interfaces:**
- Consumes: `requireAgentKey` (Task 1), `createOfferReservation`/`confirmOfferReservation`/`releaseOfferReservation` (Task 3), `getDocumentByReservation` + `createOrGetDocument` für den PDF-Abruf, `guestyClient.getReservation`
- Produces (alle hinter `X-Agent-Key`):
  - `POST /api/agent/reservations` → 201 `CreateOfferResult` als JSON
  - `GET  /api/agent/reservations/:id` → 200 `{ id, status, checkIn, checkOut, ... }` (Guesty-Rohstatus, fürs Monitoren)
  - `GET  /api/agent/reservations/:id/offer.pdf` → 200 `application/pdf` (Header `X-Document-Number`)
  - `POST /api/agent/reservations/:id/confirm` → 200 `{ ok: true }`
  - `POST /api/agent/reservations/:id/cancel` → 200 `{ ok: true }`

- [ ] **Step 1: Failing Tests schreiben**

```ts
// src/routes/agent-api.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, agentApiKey: 'test-agent-key-0123456789abcdef0123456789' } };
});
vi.mock('../services/reservation-service.js', () => ({
  createOfferReservation: vi.fn().mockResolvedValue({
    reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042',
    holdUntil: '2026-08-07', priceSource: 'manual',
  }),
  confirmOfferReservation: vi.fn().mockResolvedValue(undefined),
  releaseOfferReservation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fake'), isNew: false,
  }),
}));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getReservation: vi.fn().mockResolvedValue({ _id: 'res-1', status: 'reserved' }) },
}));

import agentApiRoutes from './agent-api.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };

describe('agent-api', () => {
  it('401 ohne Key', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', body: '{}' , headers: { 'Content-Type': 'application/json' }});
    expect(r.status).toBe(401);
  });

  it('POST /reservations → 201 mit Service-Ergebnis', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ propertySlug: 'farmhouse', checkIn: '2026-09-09', checkOut: '2026-09-10', guestsCount: 15, guest: { firstName: 'N', lastName: 'L', email: 'n@x.de' }, priceGross: 2850 }),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ reservationId: 'res-1', documentNumber: 'A-2026-0042' });
  });

  it('GET /reservations/:id → Guesty-Status', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'reserved' });
  });

  it('GET /reservations/:id/offer.pdf → PDF mit Nummer im Header', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1/offer.pdf`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('x-document-number')).toBe('A-2026-0042');
  });

  it('confirm + cancel → 200', async () => {
    const c = await fetch(`${base}/api/agent/reservations/res-1/confirm`, { method: 'POST', headers: KEY });
    expect(c.status).toBe(200);
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(200);
  });

  it('AppError des Service wird als Statuscode gemappt (ValidationError→400)', async () => {
    const { createOfferReservation } = await import('../services/reservation-service.js');
    const { ValidationError } = await import('../utils/errors.js');
    (createOfferReservation as any).mockRejectedValueOnce(new ValidationError('bad input'));
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', headers: KEY, body: '{}' });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/routes/agent-api.test.ts`
Expected: FAIL („Cannot find module … agent-api.js")

- [ ] **Step 3: Route implementieren**

```ts
// src/routes/agent-api.ts
/**
 * Agent API — maschineller Zugang für den Angebots-Workflow (Claude).
 * Auth: Header X-Agent-Key (siehe middleware/agent-key.ts).
 * Spec: docs/superpowers/specs/2026-07-24-agent-reservierung-design.md
 */
import express from 'express';
import { requireAgentKey } from '../middleware/agent-key.js';
import {
  createOfferReservation,
  confirmOfferReservation,
  releaseOfferReservation,
} from '../services/reservation-service.js';
import { createOrGetDocument } from '../services/document-service.js';
import { guestyClient } from '../services/guesty-client.js';
import { AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(requireAgentKey);

function handleError(res: express.Response, err: unknown) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  logger.error({ err }, 'Agent API: unexpected error');
  return res.status(500).json({ error: 'Internal error' });
}

router.post('/reservations', async (req, res) => {
  try {
    const result = await createOfferReservation(req.body);
    res.status(201).json(result);
  } catch (err) { handleError(res, err); }
});

router.get('/reservations/:id', async (req, res) => {
  try {
    const r = await guestyClient.getReservation(req.params.id);
    res.json({
      id: r?._id ?? req.params.id,
      status: r?.status ?? null,
      checkIn: r?.checkInDateLocalized ?? null,
      checkOut: r?.checkOutDateLocalized ?? null,
      guestsCount: r?.guestsCount ?? null,
    });
  } catch (err) { handleError(res, err); }
});

router.get('/reservations/:id/offer.pdf', async (req, res) => {
  try {
    const { document, pdf } = await createOrGetDocument({ reservationId: req.params.id, documentType: 'quote' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Document-Number', document.documentNumber);
    res.setHeader('Content-Disposition', `attachment; filename="Angebot_${document.documentNumber}.pdf"`);
    res.send(pdf);
  } catch (err) { handleError(res, err); }
});

router.post('/reservations/:id/confirm', async (req, res) => {
  try {
    await confirmOfferReservation(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

router.post('/reservations/:id/cancel', async (req, res) => {
  try {
    await releaseOfferReservation(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

export default router;
```

Falls `AppError` kein Feld `statusCode` hat (prüfen in `src/utils/errors.ts` — evtl. heißt es `status`), Feldzugriff anpassen.

- [ ] **Step 4: In `src/app.ts` mounten**

Import bei den anderen Routen-Imports:

```ts
import agentApiRoutes from './routes/agent-api.js';
```

Mount VOR den `/admin`-Zeilen (Auth macht die Route selbst):

```ts
  app.use('/api/agent', agentApiRoutes);
```

- [ ] **Step 5: Tests laufen lassen — müssen grün sein**

Run: `npx vitest run src/routes/agent-api.test.ts`
Expected: alle Tests passed

- [ ] **Step 6: Gesamte Suite + Build prüfen**

Run: `npx vitest run && npm run build`
Expected: Suite grün, Build ohne Fehler

- [ ] **Step 7: Commit**

```bash
git add src/routes/agent-api.ts src/routes/agent-api.test.ts src/app.ts
git commit -m "feat(agent-api): /api/agent routes (create/status/pdf/confirm/cancel) hinter X-Agent-Key"
```

---

### Task 5: Admin-Formular „Neue Reservierung + Angebot"

**Files:**
- Modify: `src/routes/admin.ts` (zwei neue Handler; Muster: bestehende `res.send(\`<!DOCTYPE html>…\`)`-Seiten, z. B. ab Zeile 32)

**Interfaces:**
- Consumes: `createOfferReservation` (Task 3) — Import oben in `admin.ts` ergänzen: `import { createOfferReservation } from '../services/reservation-service.js';`
- Produces: `GET /admin/reservations/new` (Formular) · `POST /admin/reservations` (JSON-Antwort des Service)

- [ ] **Step 1: Formular-Seite implementieren**

In `src/routes/admin.ts` (am Ende der Route-Definitionen, vor dem `export default router;`):

```ts
/**
 * GET /admin/reservations/new — Formular: Hold-Reservierung + Angebot anlegen
 */
router.get('/reservations/new', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Neue Reservierung + Angebot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-top: .8rem; font-weight: 600; }
    input, select { width: 100%; padding: .5rem; margin-top: .2rem; box-sizing: border-box; }
    button { margin-top: 1.2rem; padding: .6rem 1.4rem; font-size: 1rem; cursor: pointer; }
    #result { margin-top: 1rem; padding: .8rem; border-radius: 6px; display: none; }
    #result.ok { display: block; background: #e6f6e6; }
    #result.err { display: block; background: #fde8e8; }
    .row { display: flex; gap: .8rem; } .row > div { flex: 1; }
  </style>
</head>
<body>
  <h1>Neue Reservierung + Angebot</h1>
  <p>Legt einen Hold (Status „reserved") in Guesty an und erzeugt das Angebots-PDF.</p>
  <form id="f">
    <label>Objekt
      <select name="propertySlug">
        <option value="farmhouse">Farmhouse Prasser</option>
        <option value="u19">Uferstrasse 19</option>
      </select>
    </label>
    <div class="row">
      <div><label>Check-in <input type="date" name="checkIn" required></label></div>
      <div><label>Check-out <input type="date" name="checkOut" required></label></div>
    </div>
    <label>Personen <input type="number" name="guestsCount" min="1" value="2" required></label>
    <div class="row">
      <div><label>Vorname <input name="firstName" required></label></div>
      <div><label>Nachname <input name="lastName" required></label></div>
    </div>
    <label>E-Mail <input type="email" name="email" required></label>
    <label>Telefon (optional) <input name="phone"></label>
    <label>Pauschalpreis € (leer = Guesty-Preis) <input type="number" name="priceGross" min="1" step="0.01"></label>
    <label>Hold bis (leer = +14 Tage) <input type="date" name="holdUntil"></label>
    <button type="submit">Anlegen + Angebot erzeugen</button>
  </form>
  <div id="result"></div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        propertySlug: fd.get('propertySlug'),
        checkIn: fd.get('checkIn'),
        checkOut: fd.get('checkOut'),
        guestsCount: parseInt(fd.get('guestsCount'), 10),
        guest: { firstName: fd.get('firstName'), lastName: fd.get('lastName'), email: fd.get('email'), phone: fd.get('phone') || undefined },
        priceGross: fd.get('priceGross') ? parseFloat(fd.get('priceGross')) : undefined,
        holdUntil: fd.get('holdUntil') || undefined,
      };
      const el = document.getElementById('result');
      el.className = ''; el.textContent = 'Wird angelegt …'; el.style.display = 'block';
      try {
        const r = await fetch('/admin/reservations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Fehler');
        el.className = 'ok';
        el.innerHTML = 'Reservierung <b>' + data.reservationId + '</b> angelegt, Hold bis ' + data.holdUntil +
          (data.documentNumber ? ' — Angebot <b>' + data.documentNumber + '</b>' : '') +
          (data.documentError ? '<br>⚠️ Angebot fehlgeschlagen: ' + data.documentError : '');
      } catch (err) {
        el.className = 'err'; el.textContent = 'Fehler: ' + err.message;
      }
    });
  </script>
</body>
</html>`);
});

/**
 * POST /admin/reservations — Formular-Backend (gleicher Service wie Agent-API)
 */
router.post('/reservations', async (req, res) => {
  try {
    const result = await createOfferReservation(req.body);
    res.status(201).json(result);
  } catch (err) {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Internal error' });
  }
});
```

Oben in `admin.ts` ergänzen (falls nicht vorhanden): `import { AppError } from '../utils/errors.js';` und der `createOfferReservation`-Import (siehe Interfaces). Objekt-Auswahl bewusst statisch (nur die zwei Guesty-Objekte — Global Constraint).

- [ ] **Step 2: Build + Suite prüfen**

Run: `npm run build && npx vitest run`
Expected: Build ok, Suite grün

- [ ] **Step 3: Manuelle Verifikation lokal (ohne echten Guesty-Call)**

Lokalen Server starten (`npm run dev`), im Browser `http://localhost:3000/admin/reservations/new` öffnen (Google-Login nötig): Formular rendert, Absenden mit Vergangenheits-Datum liefert die Validierungsfehlermeldung im roten Kasten (kein Guesty-Call nötig).

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(agent-api): Admin-Formular Neue Reservierung + Angebot"
```

---

### Task 6: Echt-Verifikation, Deploy, Schlüssel-Übergabe

**Files:**
- Create: `scripts/agent-reservation-smoke.ts`
- Modify: Server-`.env` (`/opt/guesty-calendar-app/.env`, NICHT im Repo) + lokale TheBrain2-`.env`
- Modify: `CLAUDE.md` (App-Repo — kurzer Abschnitt „Agent-API")

**Interfaces:**
- Consumes: `reservation-service` (Task 3), echte Guesty-Credentials aus `.env`
- Produces: verifizierter Ende-zu-Ende-Flow + deployte Route + dokumentierter Zugang

- [ ] **Step 1: Smoke-Script schreiben**

```ts
// scripts/agent-reservation-smoke.ts
/**
 * Echt-Verifikation gegen Guesty: legt eine Hold-Reservierung WEIT in der
 * Zukunft an (Farmhouse, 2 Nächte, 1 € Pauschale), prüft den Status,
 * erzeugt das Angebot und storniert SOFORT wieder.
 *
 * Aufruf (lokal, echte Creds in .env):
 *   npx tsx scripts/agent-reservation-smoke.ts
 */
import { createOfferReservation, releaseOfferReservation } from '../src/services/reservation-service.js';
import { guestyClient } from '../src/services/guesty-client.js';

async function main() {
  const checkIn = '2027-03-01';
  const checkOut = '2027-03-03';

  console.log('1) Hold anlegen …');
  const result = await createOfferReservation({
    propertySlug: 'farmhouse',
    checkIn,
    checkOut,
    guestsCount: 2,
    guest: { firstName: 'Smoke', lastName: 'Test', email: 'micha+smoketest@remoterepublic.com' },
    priceGross: 1,
  });
  console.log('   →', JSON.stringify(result, null, 2));

  console.log('2) Status prüfen …');
  const r = await guestyClient.getReservation(result.reservationId);
  console.log('   → status:', r?.status, '| fareAccommodation:', r?.money?.fareAccommodation);

  console.log('3) Stornieren …');
  await releaseOfferReservation(result.reservationId);
  const r2 = await guestyClient.getReservation(result.reservationId);
  console.log('   → status nach Cancel:', r2?.status);

  if (result.documentError) {
    console.error('⚠️ Angebot fehlgeschlagen:', result.documentError);
    process.exit(1);
  }
  console.log('✅ Smoke-Test ok — Angebotsnummer', result.documentNumber, '(Reservierung storniert)');
}

main().catch((err) => { console.error('❌', err); process.exit(1); });
```

- [ ] **Step 2: Smoke-Test lokal ausführen**

Run: `npx tsx scripts/agent-reservation-smoke.ts`
Expected: Status `reserved` → nach Cancel `canceled`; Angebotsnummer `A-2026-NNNN` ausgegeben; `fareAccommodation: 1`.
**Bei Fehlern hier STOPPEN und an die Hauptsession melden** — mögliche Abweichungen der Guesty-API (z. B. Status-Endpoint-Pfad): erst Client-Methode korrigieren (inkl. Test aus Task 2), dann Smoke-Test wiederholen.
**Achtung Nummernkreis:** der Test verbraucht eine echte Angebotsnummer (`A-…`) — das ist ok (Angebote müssen nicht lückenlos sein, nur Rechnungen), im Ergebnis-Report aber erwähnen.

- [ ] **Step 3: Commit**

```bash
git add scripts/agent-reservation-smoke.ts
git commit -m "test(agent-api): Ende-zu-Ende-Smoke-Script (Hold anlegen, prüfen, stornieren)"
```

- [ ] **Step 4: `CLAUDE.md` des App-Repos ergänzen**

Kurzer Abschnitt (bei den anderen Feature-Doku-Abschnitten) — Inhalt:

```markdown
## Agent-API (Angebots-Workflow, seit 07/2026)

API-Key-geschützte Endpoints für den maschinellen Angebots-Workflow
(Spec: `docs/superpowers/specs/2026-07-24-agent-reservierung-design.md`):

- Auth: Header `X-Agent-Key` = `AGENT_API_KEY` aus `.env` (min. 32 Zeichen; fehlt er, antwortet die Route 503).
- `POST /api/agent/reservations` — Gast + Hold (`reserved`, `reservedUntil: -1`) + Angebots-PDF; Body siehe `src/services/reservation-service.ts` (`CreateOfferInput`).
- `GET /api/agent/reservations/:id` · `GET …/:id/offer.pdf` · `POST …/:id/confirm` · `POST …/:id/cancel`
- Admin-Pendant: Formular unter `/admin/reservations/new`.
- Hold-Fristen verwaltet der aufrufende Agent (kein Auto-Expiry in der App).
```

```bash
git add CLAUDE.md
git commit -m "docs: Agent-API Abschnitt in CLAUDE.md"
```

- [ ] **Step 5: Deploy**

```bash
# Key generieren (lokal):
openssl rand -hex 32

git push
ssh deploy@guesty.remoterepublic.com "cd /opt/guesty-calendar-app && git pull && npm install && npm run build"
# AGENT_API_KEY=<generierter Key> in /opt/guesty-calendar-app/.env ergänzen (ssh, editor)
ssh deploy@guesty.remoterepublic.com "pm2 restart guesty-calendar"
```

- [ ] **Step 6: Remote-Smoke (vom Laptop)**

```bash
# 401 ohne Key:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://guesty.remoterepublic.com/api/agent/reservations
# Expected: 401

# Status-Read mit Key (nutzt die ID aus dem lokalen Smoke-Test):
curl -s -H "X-Agent-Key: $AGENT_API_KEY" https://guesty.remoterepublic.com/api/agent/reservations/<smoke-test-id>
# Expected: JSON mit "status":"canceled"
```

- [ ] **Step 7: Schlüssel-Übergabe an Claude**

`AGENT_API_KEY=<Key>` in die gitignorte `.env` von `~/Development/TheBrain2` eintragen (dort liegen bereits SMARTTASKS_API_KEY etc.). KEIN Commit des Keys, nirgends loggen.

---

## Selbst-Review (erledigt beim Schreiben)

- **Spec-Abdeckung:** Spike ✓ (erledigt, Ergebnis in Spec) · Client-Writes → Task 2 · Service inkl. Reihenfolge/409/Teilfehler/14-Tage-Default → Task 3 · Agent-Route + Key-Middleware + Status/Confirm/Cancel/PDF → Tasks 1+4 · Admin-Formular → Task 5 · Echt-Test + Deploy + Key-Ablage + Doku → Task 6. **Bewusste Abweichung von der Spec:** das lokale Availability-Upsert nach dem Anlegen entfällt (YAGNI) — Guesty ist beim Buchen autoritativ (Hold verhindert Doppelbuchung sofort), der reguläre ETL zieht die lokale Anzeige binnen ~1 h nach.
- **Platzhalter:** keine — zwei explizit markierte Prüfstellen (Feldname `documentNumber`, `AppError.statusCode`) sind Verifikationsanweisungen mit klarer Handlung, kein offenes Design.
- **Typ-Konsistenz:** `createGuest`/`createReservation`/`updateReservationStatus` (Task 2) = Aufrufe in Task 3; `CreateOfferInput`/`CreateOfferResult` (Task 3) = Route-Body/Antwort in Task 4 und Formular-Body in Task 5; `documentType: 'quote'` durchgängig.
