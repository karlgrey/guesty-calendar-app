-- Migration: Add guest fingerprint columns
-- Created: 2026-05-13
-- Description: Adds two nullable columns to enable repeat-customer detection
--              without additional Guesty API calls. Computed locally from guest_name.
--              See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md

ALTER TABLE reservations ADD COLUMN internal_guest_id TEXT;
ALTER TABLE reservations ADD COLUMN guest_company TEXT;

CREATE INDEX IF NOT EXISTS idx_reservations_internal_guest_id
  ON reservations(internal_guest_id);
