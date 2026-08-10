import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchSpy = vi.fn(async function* () {
  // no messages
});

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    fetch: fetchSpy,
  })),
}));

import { AirbnbImapClient } from './imap-client.js';

describe('AirbnbImapClient.fetchNewMails', () => {
  beforeEach(() => fetchSpy.mockClear());

  it('passes {uid: true} as fetch OPTIONS so the range is a UID range', async () => {
    const client = new AirbnbImapClient({
      host: 'imap.example.com', port: 993, user: 'u', password: 'p', mailbox: 'Label',
    });
    await client.connect();
    await client.fetchNewMails(425);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [range, , options] = fetchSpy.mock.calls[0];
    expect(range).toBe('426:*');
    expect(options).toEqual({ uid: true });
  });
});
