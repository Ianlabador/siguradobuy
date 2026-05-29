-- ============================================================
-- SiguradoBuy Database Schema
-- Run this in Supabase SQL editor to initialize the database
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         TEXT UNIQUE,
  email         TEXT UNIQUE,
  display_name  TEXT,
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  reputation    INT NOT NULL DEFAULT 0,
  checks_today  INT NOT NULL DEFAULT 0,
  checks_reset  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SELLER PROFILES (aggregated trust data per platform seller)
-- ============================================================
CREATE TABLE IF NOT EXISTS seller_profiles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform      TEXT NOT NULL CHECK (platform IN ('shopee','lazada','tiktok','facebook','other')),
  seller_id     TEXT NOT NULL,
  seller_name   TEXT NOT NULL,
  seller_url    TEXT,
  trust_score   INT NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  report_count  INT NOT NULL DEFAULT 0,
  check_count   INT NOT NULL DEFAULT 0,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, seller_id)
);

-- ============================================================
-- PRODUCT CHECKS (every analysis request)
-- ============================================================
CREATE TABLE IF NOT EXISTS product_checks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  input_url     TEXT,
  input_type    TEXT NOT NULL DEFAULT 'url' CHECK (input_type IN ('url', 'screenshot')),
  platform      TEXT CHECK (platform IN ('shopee','lazada','tiktok','facebook','other')),
  product_name  TEXT,
  price         NUMERIC,
  currency      TEXT DEFAULT 'PHP',
  seller_name   TEXT,
  seller_id     TEXT,
  seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL,
  risk_score    INT CHECK (risk_score BETWEEN 0 AND 100),
  risk_level    TEXT CHECK (risk_level IN ('low','medium','high')),
  ai_summary    TEXT,
  signals       JSONB DEFAULT '{}',
  partial_data  BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SCAM REPORTS (community-submitted)
-- ============================================================
CREATE TABLE IF NOT EXISTS scam_reports (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  seller_name     TEXT,
  seller_url      TEXT,
  seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL,
  platform        TEXT CHECK (platform IN ('shopee','lazada','tiktok','facebook','other')),
  evidence_urls   TEXT[] DEFAULT '{}',
  description     TEXT NOT NULL,
  amount_lost     NUMERIC,
  currency        TEXT DEFAULT 'PHP',
  verified        BOOLEAN DEFAULT FALSE,
  upvotes         INT NOT NULL DEFAULT 0,
  check_id        UUID REFERENCES product_checks(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RESULT FEEDBACK (was our analysis correct?)
-- ============================================================
CREATE TABLE IF NOT EXISTS result_feedback (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  check_id      UUID NOT NULL REFERENCES product_checks(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  was_correct   BOOLEAN NOT NULL,
  actual_outcome TEXT CHECK (actual_outcome IN ('safe','scam','unknown')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(check_id, user_id)
);

-- ============================================================
-- PRICE BASELINES (for anomaly detection)
-- ============================================================
CREATE TABLE IF NOT EXISTS price_baselines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_keyword TEXT NOT NULL,
  platform        TEXT,
  avg_price       NUMERIC NOT NULL,
  min_price       NUMERIC NOT NULL,
  max_price       NUMERIC NOT NULL,
  sample_count    INT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_keyword, platform)
);

-- ============================================================
-- SCAM KEYWORDS (weighted signal dictionary)
-- ============================================================
CREATE TABLE IF NOT EXISTS scam_keywords (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword   TEXT NOT NULL UNIQUE,
  weight    FLOAT NOT NULL DEFAULT 5.0 CHECK (weight BETWEEN 1 AND 20),
  language  TEXT NOT NULL DEFAULT 'both' CHECK (language IN ('en','fil','both')),
  category  TEXT NOT NULL CHECK (category IN ('urgency','fake_discount','pressure','impersonation','payment','suspicious'))
);

-- ============================================================
-- REPORT UPVOTES (prevent double-upvoting)
-- ============================================================
CREATE TABLE IF NOT EXISTS report_upvotes (
  report_id  UUID NOT NULL REFERENCES scam_reports(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (report_id, user_id)
);

-- ============================================================
-- INDEXES for query performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_product_checks_user       ON product_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_product_checks_seller     ON product_checks(seller_profile_id);
CREATE INDEX IF NOT EXISTS idx_product_checks_created    ON product_checks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scam_reports_platform     ON scam_reports(platform);
CREATE INDEX IF NOT EXISTS idx_scam_reports_seller       ON scam_reports(seller_profile_id);
CREATE INDEX IF NOT EXISTS idx_scam_reports_created      ON scam_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_name      ON seller_profiles(seller_name);
CREATE INDEX IF NOT EXISTS idx_price_baselines_keyword   ON price_baselines(product_keyword);

-- ============================================================
-- ROW LEVEL SECURITY (enable for Supabase)
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scam_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_feedback ENABLE ROW LEVEL SECURITY;

-- Public read on scam_reports (community transparency)
CREATE POLICY "scam_reports_public_read" ON scam_reports
  FOR SELECT USING (true);

-- Users can insert their own reports
CREATE POLICY "scam_reports_user_insert" ON scam_reports
  FOR INSERT WITH CHECK (reporter_id = auth.uid() OR reporter_id IS NULL);

-- Users see their own checks
CREATE POLICY "checks_user_read" ON product_checks
  FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);

-- Public read on seller_profiles
CREATE POLICY "seller_profiles_public_read" ON seller_profiles
  FOR SELECT USING (true);
