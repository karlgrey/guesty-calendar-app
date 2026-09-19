// Einmalig: npm run webhook:register — legt die Subscription an (falls nicht vorhanden) und gibt das Secret aus.
import { config } from '../config/index.js';
import { guestyClient } from '../services/guesty-client.js';

const url = `${config.baseUrl.replace(/\/$/, '')}/api/webhooks/guesty`;
const existing = await guestyClient.listWebhooks();
const hit = existing.find((w: any) => w.url === url);
if (hit) console.log(`Subscription existiert bereits: ${hit._id} (${(hit.events ?? []).join(',')})`);
else { const created = await guestyClient.createWebhook(url, ['reservation.messageReceived']); console.log(`Angelegt: ${created?._id ?? JSON.stringify(created)}`); }
console.log(`\nGUESTY_WEBHOOK_SECRET=${await guestyClient.getWebhookSecret()}`);
console.log('→ in die Server-.env eintragen und pm2 restart.');
process.exit(0);
