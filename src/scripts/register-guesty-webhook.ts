// Einmalig: npm run webhook:register — legt die Subscription an (falls nicht vorhanden) und gibt das Secret aus.
import { config } from '../config/index.js';
import { guestyClient } from '../services/guesty-client.js';

const REQUIRED_EVENT = 'reservation.messageReceived';
const url = `${config.baseUrl.replace(/\/$/, '')}/api/webhooks/guesty`;
const existing = await guestyClient.listWebhooks();
const hit = existing.find((w: any) => w.url === url);
if (hit) {
  console.log(`Subscription existiert bereits: ${hit._id} (${(hit.events ?? []).join(',')})`);
  // Nicht automatisch ändern (Fix-Runde 1, #4) — nur deutlich auf eine fehlende
  // Gastnachrichten-Subscription hinweisen, Micha entscheidet über die Änderung.
  if (!(hit.events ?? []).includes(REQUIRED_EVENT)) {
    console.log(`ACHTUNG: Subscription ${hit._id} enthält NICHT "${REQUIRED_EVENT}" — Webhook wird nicht auslösen. Bitte im Guesty-Dashboard oder manuell nachtragen (kein Auto-Fix).`);
  }
} else {
  const created = await guestyClient.createWebhook(url, [REQUIRED_EVENT]);
  console.log(`Angelegt: ${created?._id ?? JSON.stringify(created)}`);
}
console.log(`\nGUESTY_WEBHOOK_SECRET=${await guestyClient.getWebhookSecret(url)}`);
console.log('→ in die Server-.env eintragen und pm2 restart.');
process.exit(0);
