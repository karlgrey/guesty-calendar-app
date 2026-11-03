import { describe, it, expect } from 'vitest';
import { dedupeOwnSendEchoes, ECHO_WINDOW_MS, ECHO_DST_OFFSET_MS } from './own-send-dedupe.js';
import type { Message } from '../types/messages.js';

const T = 'hostex:t1';
function msg(over: Partial<Message> & { id: string; sent_at: string }): Message {
  return {
    thread_id: T, direction: 'outbound', from_name: 'host', from_address: null, to_address: null,
    subject: null, body: '', body_html: null, source: 'hostex', raw_meta: null, ...over,
  };
}
const own = (id: string, sent_at: string, body: string, ext: string | null = null, draftId = 'd1') =>
  msg({ id, sent_at, body, raw_meta: JSON.stringify({ draftId, externalMessageId: ext, sentBy: 'micha' }) });
const echo = (id: string, sent_at: string, body: string) =>
  msg({ id, sent_at, body, raw_meta: JSON.stringify({ sender_role: 'host' }) });

describe('dedupeOwnSendEchoes', () => {
  it('exportiert die Konstanten', () => {
    expect(ECHO_WINDOW_MS).toBe(120_000);
    expect(ECHO_DST_OFFSET_MS).toBe(3_600_000);
  });

  it('Fall 1 (Sommerzeit, 1h-Versatz): 3 Antworten + Gast-Dank → 4 Nachrichten', () => {
    const input = [
      echo('hostex:e1', '2026-10-23T05:55:47+00:00', 'Antwort 1'),
      echo('hostex:e2', '2026-10-23T06:03:35+00:00', 'Antwort 2'),
      echo('hostex:e3', '2026-10-23T06:03:52+00:00', 'Antwort 3'),
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'Antwort 1', null, 'd1'),
      own('sent:d2', '2026-10-23T07:03:36.277Z', 'Antwort 2', null, 'd2'),
      own('sent:d3', '2026-10-23T07:03:52.462Z', 'Antwort 3', null, 'd3'),
      msg({ id: 'hostex:g1', direction: 'inbound', sent_at: '2026-10-23T07:04:31+00:00', body: 'Danke' }),
    ];
    const out = dedupeOwnSendEchoes(input);
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.body)).toEqual(['Antwort 1', 'Antwort 2', 'Antwort 3', 'Danke']);
    expect(out.map((m) => m.id)).toEqual(['hostex:e1', 'hostex:e2', 'hostex:e3', 'hostex:g1']);
    expect(out[0].sent_at).toBe('2026-10-23T06:55:48.285Z');
  });

  it('Fall 2 (Winterzeit, \\r\\n, 1 s) → 2 Nachrichten', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-26T09:44:23+00:00', 'Hallo\r\nGast A'),
      own('sent:d1', '2026-10-26T09:44:24.155Z', 'Hallo\nGast A'),
    ]);
    // 2 Nachrichten: hier nur 1 Host-Antwort; mit Gast-Antwort ergibt sich 2
    expect(out).toHaveLength(1);
    const withGuest = dedupeOwnSendEchoes([
      msg({ id: 'hostex:g0', direction: 'inbound', sent_at: '2026-10-26T09:00:00+00:00', body: 'Frage' }),
      echo('hostex:e1', '2026-10-26T09:44:23+00:00', 'Hallo\r\nGast A'),
      own('sent:d1', '2026-10-26T09:44:24.155Z', 'Hallo\nGast A'),
    ]);
    expect(withGuest).toHaveLength(2);
  });

  it('ID-Match ohne Textgleichheit', () => {
    const out = dedupeOwnSendEchoes([
      own('hostex:77', '2026-10-23T06:55:48.285Z', 'Text', '77'),
      echo('hostex:77x', '2026-10-23T02:00:00+00:00', ''),
      echo('hostex:88', '2026-10-23T02:00:00+00:00', ''),
    ]);
    // 77 != 77x, 88 != 77 → kein Match
    expect(out).toHaveLength(3);
    const out2 = dedupeOwnSendEchoes([
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'Text', 'hostex:99'),
      echo('hostex:99', '2026-10-20T02:00:00+00:00', ''),
    ]);
    expect(out2).toHaveLength(1);
    expect(out2[0].id).toBe('hostex:99');
    expect(out2[0].sent_at).toBe('2026-10-23T06:55:48.285Z');
  });

  it('leere externalMessageId → kein ID-Match', () => {
    const out = dedupeOwnSendEchoes([
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'A', ''),
      echo('hostex:', '2026-10-20T02:00:00+00:00', 'B'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('gleicher Text 10 min auseinander → kein Dedupe', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-23T06:45:48+00:00', 'Ok'),
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'Ok'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('zwei identische Sendungen + ein Echo → eine eigene Zeile bleibt', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-23T06:55:47+00:00', 'Ok'),
      own('sent:d1', '2026-10-23T06:55:48.000Z', 'Ok', null, 'd1'),
      own('sent:d2', '2026-10-23T06:55:50.000Z', 'Ok', null, 'd2'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.filter((m) => m.id === 'hostex:e1')).toHaveLength(1);
    expect(out.filter((m) => m.id.startsWith('sent:'))).toHaveLength(1);
  });

  it('Inbound mit gleichem Text wird nie angefasst', () => {
    const out = dedupeOwnSendEchoes([
      msg({ id: 'hostex:g1', direction: 'inbound', sent_at: '2026-10-23T06:55:47+00:00', body: 'Ok' }),
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'Ok'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('eigene Zeile ohne Echo bleibt', () => {
    const o = own('sent:d1', '2026-10-23T06:55:48.285Z', 'Ok');
    expect(dedupeOwnSendEchoes([o])).toEqual([o]);
  });

  it('raw_meta kaputt/null → keine eigene Zeile', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-23T06:55:47+00:00', 'Ok'),
      msg({ id: 'sent:x', sent_at: '2026-10-23T06:55:48Z', body: 'Ok', raw_meta: '{kaputt' }),
      msg({ id: 'sent:y', sent_at: '2026-10-23T06:55:48Z', body: 'Ok', raw_meta: null }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('mutiert die Eingabe nicht', () => {
    const e = echo('hostex:e1', '2026-10-23T06:55:47+00:00', 'Ok');
    dedupeOwnSendEchoes([e, own('sent:d1', '2026-10-23T06:55:48.285Z', 'Ok')]);
    expect(e.sent_at).toBe('2026-10-23T06:55:47+00:00');
  });
});

describe('dedupeOwnSendEchoes — Fehl-Dedupe-Risiko des 1-h-Fensters (Prüfer #974)', () => {
  it('zwei legitime textgleiche Antworten 1 h auseinander (Sommerzeit-Versatz) bleiben beide, 1:1 zugeordnet', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-23T09:00:00+00:00', 'Ok'),
      echo('hostex:e2', '2026-10-23T10:00:00+00:00', 'Ok'),
      own('sent:d1', '2026-10-23T10:00:00.500Z', 'Ok', null, 'd1'),
      own('sent:d2', '2026-10-23T11:00:00.500Z', 'Ok', null, 'd2'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['hostex:e1', 'hostex:e2']);
    expect(out.map((m) => m.sent_at)).toEqual(['2026-10-23T10:00:00.500Z', '2026-10-23T11:00:00.500Z']);
  });

  it('eigene Zeile + Echo + textgleiche Host-Nachricht 1 h später ohne eigene Zeile (z. B. Hostex-App) → nichts verschwindet', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-26T10:00:00+00:00', 'Ok'),
      own('sent:d1', '2026-10-26T10:00:00.500Z', 'Ok'),
      echo('hostex:e2', '2026-10-26T11:00:00+00:00', 'Ok'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['hostex:e1', 'hostex:e2']);
    expect(out[1].sent_at).toBe('2026-10-26T11:00:00+00:00');
  });

  it('Guest-Cursor unberührt: letzte Inbound-Zeile bleibt letzte Nachricht', () => {
    const out = dedupeOwnSendEchoes([
      echo('hostex:e1', '2026-10-23T05:55:47+00:00', 'Antwort'),
      own('sent:d1', '2026-10-23T06:55:48.285Z', 'Antwort'),
      msg({ id: 'hostex:g1', direction: 'inbound', sent_at: '2026-10-23T07:04:31+00:00', body: 'Danke' }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['hostex:e1', 'hostex:g1']);
  });
});
