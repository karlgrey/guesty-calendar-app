-- Migration: Add discount and guest notes fields to documents
-- Created: 2025-12-01
-- Description: Add support for discount display and guest notes on documents

-- Add discount fields
ALTER TABLE documents ADD COLUMN discount_total INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN discount_description TEXT;

-- Add guest notes field
ALTER TABLE documents ADD COLUMN guest_notes TEXT;
