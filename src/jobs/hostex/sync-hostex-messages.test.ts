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
});
