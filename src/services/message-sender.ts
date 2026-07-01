import type { MessageThread } from '../types/messages.js';
import { getHostexClient } from './hostex-client.js';

export interface SendDeps {
  hostexSend(conversationId: string, body: string): Promise<{ message_id: string }>;
}

const defaultDeps: SendDeps = {
  hostexSend: (conversationId, body) => getHostexClient().sendMessage(conversationId, body),
};

export async function sendReply(
  thread: MessageThread,
  body: string,
  deps: SendDeps = defaultDeps,
): Promise<{ externalMessageId: string }> {
  if (thread.source === 'hostex') {
    const conversationId = thread.id.replace(/^hostex:/, '');
    const { message_id } = await deps.hostexSend(conversationId, body);
    return { externalMessageId: message_id };
  }
  throw new Error(`sendReply: provider '${thread.source}' not implemented (Schnitt 1 = Hostex only)`);
}
