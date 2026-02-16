-- Add promotion columns to quotes_cache table
ALTER TABLE quotes_cache ADD COLUMN promotion_name TEXT;
ALTER TABLE quotes_cache ADD COLUMN promotion_type TEXT;
ALTER TABLE quotes_cache ADD COLUMN promotion_discount_percent REAL;
ALTER TABLE quotes_cache ADD COLUMN promotion_savings REAL;
