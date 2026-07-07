import type { Message, MessageThread } from '../types/messages.js';
import { getHostexClient } from './hostex-client.js';
import { guestyClient } from './guesty-client.js';
import { getMessagesByThread } from '../repositories/message-repository.js';
import { resolveOutboundModuleType } from './guesty-channel.js';

export interface SendDeps {
  hostexSend(conversationId: string, body: string): Promise<{ message_id: string }>;
  guestySend(conversationId: string, body: string, moduleType: string): Promise<{ messageId: string | null }>;
  getMessages(threadId: string): Message[];
}

const defaultDeps: SendDeps = {
  hostexSend: (conversationId, body) => getHostexClient().sendMessage(conversationId, body),
  guestySend: (conversationId, body, moduleType) =>
    guestyClient.sendConversationMessage(conversationId, body, moduleType),
  getMessages: getMessagesByThread,
};

export async function sendReply(
  thread: MessageThread,
  body: string,
  deps: SendDeps = defaultDeps,
): Promise<{ externalMessageId: string | null }> {
  if (thread.source === 'hostex') {
    const conversationId = thread.id.replace(/^hostex:/, '');
    const { message_id } = await deps.hostexSend(conversationId, body);
    return { externalMessageId: message_id };
  }
  if (thread.source === 'guesty') {
    const conversationId = thread.id.replace(/^guesty:/, '');
    const moduleType = resolveOutboundModuleType(deps.getMessages(thread.id));
    if (!moduleType) {
      throw new Error('sendReply: Kanal nicht auflösbar — bitte direkt in der Guesty-Inbox antworten');
    }
    const { messageId } = await deps.guestySend(conversationId, body, moduleType);
    return { externalMessageId: messageId };
  }
  throw new Error(`sendReply: provider '${thread.source}' not implemented`);
}
