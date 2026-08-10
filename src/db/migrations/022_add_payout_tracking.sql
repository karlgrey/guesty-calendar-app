-- Payout ground-truth tracking for the airbnb-mail provider.
-- payout_status: 'confirmed' = amount is exact (API providers, or matched payout mail),
--                'estimated' = computed from booking mail / iCal, awaiting payout mail.
ALTER TABLE reservations ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'confirmed';

UPDATE reservations SET payout_status = 'estimated' WHERE platform = 'airbnb-mail';

CREATE TABLE IF NOT EXISTS airbnb_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  reservation_code TEXT,
  payout_date TEXT NOT NULL,
  amount REAL NOT NULL,
  stay_start TEXT,
  stay_end TEXT,
  total_mail_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, reservation_code)
);

CREATE INDEX IF NOT EXISTS idx_airbnb_payouts_code ON airbnb_payouts(reservation_code);
