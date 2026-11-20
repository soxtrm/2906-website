-- Bookkeeping for services/websiteReconcile.js: every change it makes to the website copy of a listing.
-- Additive. The job reads it to know which hidden listings it hid itself (only those may be shown again).
BEGIN;
CREATE TABLE IF NOT EXISTS website_reconcile_log (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT NOW(),
  website_id         text,
  property_reference text,
  property_id        integer,
  action             text NOT NULL CHECK (action IN ('rented', 'hide', 'show', 'refresh')),
  reason             text,
  argus_status       text,
  before_state       jsonb,
  after_state        jsonb
);
CREATE INDEX IF NOT EXISTS website_reconcile_log_website_idx ON website_reconcile_log (website_id, id DESC);
COMMIT;
