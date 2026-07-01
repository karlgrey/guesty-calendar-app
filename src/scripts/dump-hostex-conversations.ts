// src/scripts/dump-hostex-conversations.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getHostexClient } from '../services/hostex-client.js';

// Roh-Fetch über den bestehenden Client-Rohkanal ist privat; hier bewusst direkt via fetch,
// nur um die echte Antwortform zu inspizieren.
async function main() {
  const token = process.env.HOSTEX_ACCESS_TOKEN;
  if (!token) throw new Error('HOSTEX_ACCESS_TOKEN fehlt');
  const base = process.env.HOSTEX_API_URL ?? 'https://api.hostex.io/v3';

  const listRes = await fetch(`${base}/conversations?limit=5&offset=0`, {
    headers: { 'Hostex-Access-Token': token, 'User-Agent': 'guesty-calendar-app' },
  });
  const list = await listRes.json();
  const firstId = list?.data?.conversations?.[0]?.id ?? list?.data?.conversations?.[0]?.conversation_id;

  let detail: unknown = null;
  if (firstId) {
    const detRes = await fetch(`${base}/conversations/${firstId}`, {
      headers: { 'Hostex-Access-Token': token, 'User-Agent': 'guesty-calendar-app' },
    });
    detail = await detRes.json();
  }

  const out = { list, detail };
  writeFileSync('src/test-fixtures/hostex/conversations.json', JSON.stringify(out, null, 2));
  console.log('Gespeichert. Top-level keys list.data:', Object.keys(list?.data ?? {}));
  console.log('Erste Conversation:', JSON.stringify(list?.data?.conversations?.[0], null, 2)?.slice(0, 800));
  console.log('Detail keys:', Object.keys((detail as any)?.data ?? {}));
}
main().catch((e) => { console.error(e); process.exit(1); });
