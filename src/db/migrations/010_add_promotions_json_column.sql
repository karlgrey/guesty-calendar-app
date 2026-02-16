-- Replace individual promotion columns with a single JSON column
ALTER TABLE quotes_cache ADD COLUMN promotions_json TEXT;
