-- Per-note opt-out of AI context.
--
-- Idempotent, matching the style of 0001. Defaults to false so existing notes
-- keep their current behaviour; the safe direction for a new column is the one
-- that changes nothing.

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "exclude_from_ai" boolean DEFAULT false NOT NULL;
