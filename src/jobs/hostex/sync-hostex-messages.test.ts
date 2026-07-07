// src/jobs/hostex/sync-hostex-messages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { getMessagesByThread, getThreadById } from '../../repositories/message-repository.js';
import { syncHostexMessagesForProperty, type HostexMessageClient } from './sync-hostex-messages.js';
import type { PropertyConfig } from '../../config/properties.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_threads (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
      conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
      raw_meta TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      manually_categorized INTEGER NOT NULL DEFAULT 0, manual_note TEXT,
      linked_thread_id TEXT, classification_reasoning TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL,
      from_name TEXT, from_address TEXT, to_address TEXT, subject TEXT, body TEXT NOT NULL, body_html TEXT,
      source TEXT NOT NULL, raw_meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const fakeClient: HostexMessageClient = {
  async getConversations() {
    return [
      { id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' }, property_title: 'Bootshaus' },
    ];
  },
  async getConversationDetails() {
    return {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' }, property_title: 'Bootshaus',
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
      ],
    };
  },
};

const property = { slug: 'bootshaus', hostexPropertyId: 'listing-9', name: 'Bootshaus' } as unknown as PropertyConfig;

// Two-property filter fixture: returns one matching and one non-matching conversation.
// getConversationDetails is only wired for the matching id (c-match).
const multiPropertyClient: HostexMessageClient = {
  async getConversations() {
    return [
      { id: 'c-match', channel_type: 'airbnb', guest: { name: 'Anna', email: '' }, property_title: 'Alte Schilderwerkstatt' },
      { id: 'c-other', channel_type: 'airbnb', guest: { name: 'Bob', email: '' }, property_title: 'Bootshaus an der alten Oder' },
    ];
  },
  async getConversationDetails(id: string) {
    if (id !== 'c-match') throw new Error(`getConversationDetails called for unexpected id: ${id}`);
    return {
      id: 'c-match', channel_type: 'airbnb', guest: { name: 'Anna', email: '' }, property_title: 'Alte Schilderwerkstatt',
      messages: [
        { id: 'm-match-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo ASW', created_at: '2026-06-30T10:00:00Z' },
      ],
    };
  },
};

const alteSchilderwerkstatt = {
  slug: 'alte-schilderwerkstatt',
  hostexPropertyId: '12659676',
  name: 'Alte Schilderwerkstatt',
} as unknown as PropertyConfig;

// Inquiries have an EMPTY property_title in the LIST; attribution comes from the
// DETAIL's activities[].property.id. 'inq-mine' belongs to 12659676, 'inq-other' does not.
const inquiryClient: HostexMessageClient = {
  async getConversations() {
    return [
      { id: 'inq-mine', channel_type: 'airbnb', guest: { name: 'Michael', email: '' }, property_title: '' },
      { id: 'inq-other', channel_type: 'airbnb', guest: { name: 'Foreign', email: '' }, property_title: '' },
    ];
  },
  async getConversationDetails(id: string) {
    if (id === 'inq-mine') {
      return {
        id: 'inq-mine', channel_type: 'airbnb', guest: { name: 'Michael', email: '' }, property_title: '',
        activities: [{ activity_type: 'inquiry', property: { id: 12659676, title: 'Alte Schilderwerkstatt' } }],
        messages: [{ id: 'im1', sender_role: 'guest', display_type: 'Text', content: 'Anfrage', created_at: '2026-06-30T10:00:00Z' }],
      };
    }
    return {
      id: 'inq-other', channel_type: 'airbnb', guest: { name: 'Foreign', email: '' }, property_title: '',
      activities: [{ activity_type: 'inquiry', property: { id: 99999999, title: 'Somewhere else' } }],
      messages: [{ id: 'im2', sender_role: 'guest', display_type: 'Text', content: 'x', created_at: '2026-06-30T10:00:00Z' }],
    };
  },
};

describe('syncHostexMessagesForProperty', () => {
  it('persists threads and messages', async () => {
    const res = await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(true);
    expect(res.threads).toBe(1);
    expect(res.messages).toBe(1);
    expect(getThreadById('hostex:c-1')?.guest_name).toBe('Darleen');
    expect(getMessagesByThread('hostex:c-1')[0].body).toBe('Hallo');
  });

  it('is idempotent on re-run (no duplicate rows)', async () => {
    await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T00:00:00Z');
    await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T01:00:00Z');
    expect(getMessagesByThread('hostex:c-1').length).toBe(1);
  });

  it('fails cleanly when hostexPropertyId is missing', async () => {
    const bad = { slug: 'x' } as unknown as PropertyConfig;
    const res = await syncHostexMessagesForProperty(bad, fakeClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(false);
  });

  it('filters to current property — does not persist conversations from other properties', async () => {
    // multiPropertyClient returns two conversations: one for "Alte Schilderwerkstatt" and one
    // for "Bootshaus an der alten Oder". Only the matching one should be persisted.
    const res = await syncHostexMessagesForProperty(alteSchilderwerkstatt, multiPropertyClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(true);
    expect(res.threads).toBe(1);
    // Matching thread must exist
    expect(getThreadById('hostex:c-match')?.guest_name).toBe('Anna');
    // Non-matching thread must NOT exist
    expect(getThreadById('hostex:c-other')).toBeNull();
  });

  it('persists an inquiry (empty property_title) attributed via the detail property id', async () => {
    const res = await syncHostexMessagesForProperty(alteSchilderwerkstatt, inquiryClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(true);
    expect(res.threads).toBe(1);
    // My inquiry (property.id 12659676) is persisted...
    expect(getThreadById('hostex:inq-mine')?.guest_name).toBe('Michael');
    expect(getMessagesByThread('hostex:inq-mine')[0].body).toBe('Anfrage');
    // ...the foreign inquiry (property.id 99999999) is not.
    expect(getThreadById('hostex:inq-other')).toBeNull();
  });

  it('skips the detail fetch for conversations unchanged since the last sync', async () => {
    let detailCalls = 0;
    const conv = {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      property_title: 'Bootshaus', last_message_at: '2026-06-30T10:00:00+00:00',
    };
    const client: HostexMessageClient = {
      async getConversations() { return [conv]; },
      async getConversationDetails() {
        detailCalls++;
        return {
          id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' }, property_title: 'Bootshaus',
          messages: [{ id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' }],
        };
      },
    };
    await syncHostexMessagesForProperty(property, client, '2026-07-01T00:00:00Z');
    expect(detailCalls).toBe(1);
    // Unverändert (Aktivität 06-30 < letzter Sync 07-01) → Detail übersprungen.
    const res2 = await syncHostexMessagesForProperty(property, client, '2026-07-01T01:00:00Z');
    expect(detailCalls).toBe(1);
    expect(res2.skippedUnchanged).toBe(1);
    // Neue Aktivität laut Liste → Detail wird wieder geladen.
    conv.last_message_at = '2026-07-02T09:00:00+00:00';
    await syncHostexMessagesForProperty(property, client, '2026-07-02T10:00:00Z');
    expect(detailCalls).toBe(2);
  });

  it('deep=true fetches details even for unchanged conversations', async () => {
    let detailCalls = 0;
    const client: HostexMessageClient = {
      async getConversations() {
        return [{
          id: 'c-1', channel_type: 'airbnb', guest: { name: 'D', email: '' },
          property_title: 'Bootshaus', last_message_at: '2026-06-30T10:00:00+00:00',
        }];
      },
      async getConversationDetails() {
        detailCalls++;
        return {
          id: 'c-1', channel_type: 'airbnb', guest: { name: 'D', email: '' }, property_title: 'Bootshaus',
          messages: [{ id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' }],
        };
      },
    };
    await syncHostexMessagesForProperty(property, client, '2026-07-01T00:00:00Z');
    await syncHostexMessagesForProperty(property, client, '2026-07-01T01:00:00Z', undefined, { deep: true });
    expect(detailCalls).toBe(2);
  });

  it('with a shared detail cache, an inquiry is fetched only once across property passes', async () => {
    let detailCalls = 0;
    const countingClient: HostexMessageClient = {
      async getConversations() {
        return [{ id: 'inq', channel_type: 'airbnb', guest: { name: 'M', email: '' }, property_title: '' }];
      },
      async getConversationDetails(id: string) {
        detailCalls++;
        return {
          id, channel_type: 'airbnb', guest: { name: 'M', email: '' }, property_title: '',
          activities: [{ activity_type: 'inquiry', property: { id: 111, title: 'A' } }],
          messages: [{ id: 'im', sender_role: 'guest', display_type: 'Text', content: 'q', created_at: '2026-06-30T10:00:00Z' }],
        };
      },
    };
    const propA = { slug: 'a', hostexPropertyId: '111', name: 'A' } as unknown as PropertyConfig;
    const propB = { slug: 'b', hostexPropertyId: '222', name: 'B' } as unknown as PropertyConfig;
    const cache = new Map();
    await syncHostexMessagesForProperty(propA, countingClient, '2026-07-01T00:00:00Z', cache);
    await syncHostexMessagesForProperty(propB, countingClient, '2026-07-01T00:00:00Z', cache);
    expect(detailCalls).toBe(1); // fetched once despite being a candidate in both passes
    expect(getThreadById('hostex:inq')?.listing_id).toBe('111'); // attributed to A only
  });
});
