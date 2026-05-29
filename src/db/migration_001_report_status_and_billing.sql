-- ============================================================
-- Migration 001: Scam Report Approval Workflow + Recurring Billing
-- Run in Supabase SQL editor
-- ============================================================

-- ── scam_reports: add approval workflow fields ────────────────────────────────

ALTER TABLE scam_reports
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'disapproved')),
  ADD COLUMN IF NOT EXISTS admin_notes   TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by   TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMPTZ;

-- Migrate old rows: treat verified=true as approved, rest as pending_review
UPDATE scam_reports
  SET status = CASE WHEN verified = true THEN 'approved' ELSE 'pending_review' END
  WHERE status = 'pending_review';

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_scam_reports_status ON scam_reports(status);

-- Update the public-read policy so only approved reports are readable by anonymous users
-- (Signed-in users can also see their own pending reports)
DROP POLICY IF EXISTS "scam_reports_public_read" ON scam_reports;

CREATE POLICY "scam_reports_approved_public_read" ON scam_reports
  FOR SELECT USING (
    status = 'approved'
    OR reporter_id = auth.uid()   -- reporters can always see their own
  );

-- ── profiles: add recurring billing / subscription fields ────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS paypal_subscription_id   TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status      TEXT NOT NULL DEFAULT 'none'
    CHECK (subscription_status IN ('none','active','cancelled','suspended','expired','past_due')),
  ADD COLUMN IF NOT EXISTS current_period_start     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_payment_status      TEXT,
  ADD COLUMN IF NOT EXISTS plan_updated_at          TIMESTAMPTZ;

-- Backfill: mark existing paid plans as subscription_status = 'active'
UPDATE profiles
  SET subscription_status = 'active',
      plan_updated_at = NOW()
  WHERE plan IN ('plus', 'pro')
    AND subscription_status = 'none';

-- Index for webhook lookups by subscription ID
CREATE INDEX IF NOT EXISTS idx_profiles_paypal_sub ON profiles(paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

-- ── Ensure scam_reports also has seller_url and product_url ──────────────────
ALTER TABLE scam_reports
  ADD COLUMN IF NOT EXISTS product_url TEXT;

-- Rename seller_url to seller_profile_url for clarity (if column exists as seller_url)
-- NOTE: Only run this if seller_url exists. Supabase allows ALTER COLUMN RENAME.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scam_reports' AND column_name = 'seller_url'
  ) THEN
    ALTER TABLE scam_reports RENAME COLUMN seller_url TO seller_profile_url;
  END IF;
END $$;
