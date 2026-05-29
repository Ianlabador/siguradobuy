-- ============================================================
-- Supabase RPC helper functions
-- Run in Supabase SQL editor after schema.sql
-- ============================================================

-- Increment report count on a seller profile by name + platform
CREATE OR REPLACE FUNCTION increment_report_count(p_seller_name TEXT, p_platform TEXT)
RETURNS void AS $$
BEGIN
  UPDATE seller_profiles
  SET report_count = report_count + 1,
      trust_score  = GREATEST(0, trust_score - 10)
  WHERE seller_name ILIKE '%' || p_seller_name || '%'
    AND platform = p_platform;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment user reputation
CREATE OR REPLACE FUNCTION increment_reputation(p_user_id UUID, p_amount INT)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET reputation = reputation + p_amount
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment report upvote count
CREATE OR REPLACE FUNCTION increment_report_upvotes(p_report_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE scam_reports
  SET upvotes = upvotes + 1
  WHERE id = p_report_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
