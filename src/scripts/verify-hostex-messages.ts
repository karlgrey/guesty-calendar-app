// src/scripts/verify-hostex-messages.ts
import 'dotenv/config';
import { getHostexClient } from '../services/hostex-client.js';

async function main() {
  const client = getHostexClient();
  const convs = await client.getConversations({ limit: 3 });
  console.log('conversations:', convs.length);
  console.log('first:', JSON.stringify(convs[0], null, 2));
  if (convs[0]) {
    const detail = await client.getConversationDetails(convs[0].id);
    console.log('messages in first:', detail.messages?.length);
    console.log('sample message:', JSON.stringify(detail.messages?.[0], null, 2));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
