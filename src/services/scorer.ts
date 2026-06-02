import { db } from '../db/client';
import type { ExtractedProduct } from './extractor';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface RiskSignals {
  priceAnomaly:        boolean;
  priceAnomalyPercent: number | null;
  newSeller:           boolean;
  sellerAgeDays:       number | null;
  noReviews:           boolean;
  lowRating:           boolean;
  lowSoldCount:        boolean;
  communityReports:    number;
  keywordsFound:       string[];
  keywordScore:        number;
  partialData:         boolean;
  platformRisk:        boolean;
}

export interface SubScores {
  scamScore:    number; // 0-100: community reports + keywords + fraud patterns
  priceScore:   number; // 0-100: price anomaly + suspicious pricing
  sellerScore:  number; // 0-100: seller age + platform risk + reports
  qualityScore: number; // 0-100: reviews + rating + sold count + confidence
}

export interface ScoringResult {
  riskScore:  number;
  riskLevel:  'low' | 'medium' | 'high';
  signals:    RiskSignals;
  subScores:  SubScores;
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

interface PriceBaseline { avg_price: number; min_price: number; max_price: number; }
interface SellerProfile {
  trust_score:  number;
  report_count: number;
  first_seen:   string;
  metadata:     Record<string, unknown>;
}

async function getPriceBaseline(keyword: string): Promise<PriceBaseline | null> {
  const normalized = keyword.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const { data } = await db
    .from('price_baselines')
    .select('avg_price, min_price, max_price')
    .ilike('product_keyword', `%${normalized.split(' ').slice(0, 2).join(' ')}%`)
    .limit(1)
    .single();
  return data ?? null;
}

async function getSellerProfile(platform: string, sellerId: string): Promise<SellerProfile | null> {
  const { data } = await db
    .from('seller_profiles')
    .select('trust_score, report_count, first_seen, metadata')
    .eq('platform', platform)
    .eq('seller_id', sellerId)
    .single();
  return data ?? null;
}

// Built-in keyword list — used when the scam_keywords table is empty or unreachable.
// These are high-confidence scam signals in Philippine online selling context.
const BUILTIN_KEYWORDS: Array<{ keyword: string; weight: number }> = [
  // Payment-first / pressure tactics
  { keyword: 'pay first',         weight: 12 },
  { keyword: 'bayad muna',        weight: 12 },
  { keyword: 'gcash only',        weight: 10 },
  { keyword: 'no return',         weight: 8  },
  { keyword: 'no refund',         weight: 8  },
  { keyword: 'rush',              weight: 6  },
  { keyword: 'limited stock',     weight: 4  },
  { keyword: 'last stock',        weight: 5  },
  // Identity / trust manipulation
  { keyword: 'legit seller',      weight: 6  },
  { keyword: 'legit',             weight: 4  },
  { keyword: 'trusted seller',    weight: 5  },
  { keyword: 'no scam',           weight: 8  },
  { keyword: 'not a scammer',     weight: 10 },
  // Urgency / fake deals
  { keyword: 'flash sale',        weight: 5  },
  { keyword: 'brand new sealed',  weight: 6  },
  { keyword: 'too good',          weight: 7  },
  { keyword: 'meet up only',      weight: 4  },
  { keyword: 'instant',           weight: 3  },
];

async function getScamKeywords(): Promise<Array<{ keyword: string; weight: number }>> {
  try {
    const { data } = await db.from('scam_keywords').select('keyword, weight');
    if (data && data.length > 0) return data;
  } catch { /* DB unavailable */ }
  // Fall back to built-in list
  return BUILTIN_KEYWORDS;
}

async function getCommunityReportCount(sellerName: string, platform: string): Promise<number> {
  // Only count APPROVED reports — pending/disapproved must NOT affect public risk scores
  const { count } = await db
    .from('scam_reports')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'approved')
    .ilike('seller_name', `%${sellerName}%`)
    .eq('platform', platform);
  return count ?? 0;
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

// ─── Platform base risk ───────────────────────────────────────────────────────
// These represent the SELLER TRUST dimension for each platform.
// Facebook/TikTok have higher base risk because sellers are unverified.
// Returns the sellerScore floor for the platform.
function platformSellerRisk(platform: string): number {
  if (platform === 'facebook') return 38; // unverified accounts, high fraud rate
  if (platform === 'tiktok')   return 30; // newer, less moderated, less seller verification
  if (platform === 'other')    return 22; // unknown platform
  return 5;  // shopee/lazada have built-in seller verification → low base
}

// ─── Price heuristics (no DB required) ───────────────────────────────────────
// Detects suspiciously cheap listings using Philippine market knowledge.
// Used when the price_baselines table has no match for this product.
interface PriceHeuristic {
  isSuspicious:    boolean;
  riskScore:       number;       // 0–100 contribution to priceScore
  estimatedPct:    number | null; // how far below reasonable market price
  reason:          string | null;
}

function checkSuspiciousPrice(price: number, productName: string | null): PriceHeuristic {
  if (price <= 0) return { isSuspicious: false, riskScore: 0, estimatedPct: null, reason: null };

  const name = (productName ?? '').toLowerCase();

  // Absolute floor — below ₱10 for any physical good is bait/test listing
  if (price < 10) {
    return { isSuspicious: true, riskScore: 80, estimatedPct: -99, reason: 'Price below ₱10 — likely a bait listing or placeholder' };
  }
  if (price < 50) {
    return { isSuspicious: true, riskScore: 65, estimatedPct: -95, reason: 'Suspiciously low price for a physical product' };
  }

  // High-value item keywords with impossibly low prices
  const highValueKeywords = ['iphone', 'macbook', 'laptop', 'playstation', 'ps5', 'ps4', 'xbox', 'rtx', 'gtx', 'airpods', 'ipad', 'samsung galaxy', 'dyson', 'nikon', 'canon', 'sony'];
  const midValueKeywords  = ['watch', 'headphones', 'speaker', 'camera', 'perfume', 'shoes', 'sneakers', 'bag', 'rayban', 'gucci', 'prada', 'lv ', 'louis vuitton'];

  for (const kw of highValueKeywords) {
    if (name.includes(kw)) {
      if (price < 1000)  return { isSuspicious: true, riskScore: 85, estimatedPct: Math.round(-((8000 - price) / 8000 * 100)), reason: `"${kw}" product priced far below typical market value` };
      if (price < 3000)  return { isSuspicious: true, riskScore: 65, estimatedPct: Math.round(-((8000 - price) / 8000 * 100)), reason: `"${kw}" product priced unusually low` };
      if (price < 8000)  return { isSuspicious: true, riskScore: 40, estimatedPct: null, reason: `"${kw}" product at lower end of expected range` };
    }
  }

  for (const kw of midValueKeywords) {
    if (name.includes(kw)) {
      if (price < 200) return { isSuspicious: true, riskScore: 60, estimatedPct: null, reason: `"${kw}" product priced well below market average` };
      if (price < 500) return { isSuspicious: true, riskScore: 35, estimatedPct: null, reason: `"${kw}" product at unusually low price` };
    }
  }

  // Electronics / gadgets generic
  const electronicsWords = ['gadget', 'electronic', 'phone', 'tablet', 'aircon', 'refrigerator', 'washer', 'tv ', 'television', 'monitor'];
  for (const kw of electronicsWords) {
    if (name.includes(kw) && price < 500) {
      return { isSuspicious: true, riskScore: 50, estimatedPct: null, reason: 'Electronic item priced unusually low' };
    }
  }

  return { isSuspicious: false, riskScore: 0, estimatedPct: null, reason: null };
}

// ─── Main scoring ─────────────────────────────────────────────────────────────

export async function scoreProduct(product: ExtractedProduct): Promise<ScoringResult> {
  const signals: RiskSignals = {
    priceAnomaly:        false,
    priceAnomalyPercent: null,
    newSeller:           false,
    sellerAgeDays:       null,
    noReviews:           false,
    lowRating:           false,
    lowSoldCount:        false,
    communityReports:    0,
    keywordsFound:       [],
    keywordScore:        0,
    partialData:         product.partial,
    platformRisk:        false,
  };

  // ── Data availability flags ────────────────────────────────────────────────
  const hasPrice    = product.price != null && product.price > 0;
  const hasSeller   = !!product.sellerName;
  const hasReviews  = product.reviewCount != null;
  const hasRating   = product.rating != null;
  const conf        = product.confidence ?? 50;
  const isUrlOnly   = product.extractMethod === 'url_only';
  const isPartial   = product.partial || isUrlOnly;

  // ── 1. Platform base risk → seller sub-score ──────────────────────────────
  // Key fix: platform risk MUST show in the seller breakdown, not just the total.
  let sellerRaw  = platformSellerRisk(product.platform);

  if (product.platform === 'facebook' || product.platform === 'other') {
    signals.platformRisk = true;
  } else if (product.platform === 'tiktok') {
    signals.platformRisk = true;
  }

  // ── 2. Missing data uncertainty → caution floors ──────────────────────────
  // Key fix: unknown ≠ safe. Missing data INCREASES uncertainty sub-scores.
  // These are NOT penalties for the seller — they're "we cannot evaluate" signals.
  let priceRaw   = hasPrice   ? 0  : 28;  // can't evaluate price fairness
  let qualityRaw = hasReviews ? 0  : 18;  // can't verify buyer history (limited data, not "bad")
  if (!hasSeller) {
    // On verified marketplaces (Shopee/Lazada) a missing seller is almost always
    // an extraction gap, NOT an anonymous seller — treat it as limited data, not risk.
    sellerRaw += (product.platform === 'shopee' || product.platform === 'lazada') ? 8 : 22;
  }

  // ── 3. Partial / url-only additional caution ──────────────────────────────
  let scamRaw = 0;
  if (isUrlOnly) {
    // We know NOTHING about this listing — treat all dimensions with caution
    scamRaw    += 18;
    sellerRaw  += 12;
    qualityRaw += 12;
    signals.partialData = true;
  } else if (isPartial) {
    scamRaw    += 8;
    qualityRaw += 8;
    signals.partialData = true;
  }

  // Missing multiple core fields together
  if (!product.productName) scamRaw   += 6;
  if (!product.price)       priceRaw  += 8;  // stacks on top of the floor
  if (!product.sellerName)  sellerRaw += 5;

  // ── 4. Price anomaly: DB baseline first, then heuristics ─────────────────
  if (hasPrice) {
    // 4a. Check DB baseline
    if (product.productName) {
      try {
        const baseline = await getPriceBaseline(product.productName);
        if (baseline && baseline.avg_price > 0) {
          const pct = ((baseline.avg_price - product.price!) / baseline.avg_price) * 100;
          signals.priceAnomalyPercent = Math.round(pct);

          if (pct > 70) {
            signals.priceAnomaly = true; priceRaw += 45;
            console.log(`[Scorer] Price: ${pct.toFixed(0)}% below baseline avg ₱${baseline.avg_price}`);
          } else if (pct > 50) { signals.priceAnomaly = true; priceRaw += 32; }
          else if (pct > 30)   { signals.priceAnomaly = true; priceRaw += 20; }
          else if (pct < -50)  { signals.priceAnomaly = true; priceRaw += 14; }
        }
      } catch { /* DB unavailable — continue with heuristics */ }
    }

    // 4b. Heuristic price check (works without DB)
    if (!signals.priceAnomaly) {
      const ph = checkSuspiciousPrice(product.price!, product.productName);
      if (ph.isSuspicious) {
        signals.priceAnomaly = true;
        if (ph.estimatedPct != null) signals.priceAnomalyPercent = ph.estimatedPct;
        priceRaw = Math.max(priceRaw, ph.riskScore);
        console.log(`[Scorer] Price heuristic: ${ph.reason} (price=₱${product.price})`);
      }
    }
  }

  // ── 5. Seller trust check ─────────────────────────────────────────────────
  if (product.sellerId && product.platform !== 'other') {
    try {
      const sp = await getSellerProfile(product.platform, product.sellerId);
      if (sp) {
        const ageDays = daysSince(sp.first_seen);
        signals.sellerAgeDays = ageDays;

        if (ageDays < 7) {
          signals.newSeller = true; sellerRaw += 32;
          console.log(`[Scorer] New seller: ${ageDays} days old`);
        } else if (ageDays < 30) {
          signals.newSeller = true; sellerRaw += 22;
        } else if (ageDays < 90) {
          sellerRaw += 8;
        }
        // Established sellers (>90 days): no additional penalty

        signals.communityReports = sp.report_count;
        const reportPenalty = Math.min(sp.report_count * 14, 50);
        scamRaw   += reportPenalty;
        sellerRaw += Math.min(sp.report_count * 8, 30);

        const trustPenalty = Math.floor((100 - sp.trust_score) / 6);
        sellerRaw += trustPenalty;
      } else {
        // Seller not in our DB — unknown seller on this platform
        sellerRaw += 10;
      }
    } catch { /* DB unavailable */ }
  }

  // ── 6. Review / quality signals ───────────────────────────────────────────
  // HONESTY RULE: `noReviews` means "confirmed zero reviews", NOT "we failed to
  // extract review data". Missing review data is handled as limited data above,
  // never as a fabricated "No reviews" signal.
  if (hasReviews) {
    if (product.reviewCount === 0) {
      signals.noReviews = true; qualityRaw += 18;
    } else if (product.reviewCount! < 5) {
      qualityRaw += 10;
    } else if (product.reviewCount! >= 100) {
      // Lots of real buyers — strong legitimacy + quality signal.
      qualityRaw = Math.max(0, qualityRaw - 8);
    }
  }
  // else: review data missing → no signal set (limited verification only)

  if (hasRating) {
    if (product.rating! < 2.5) {
      signals.lowRating = true; qualityRaw += 22;
    } else if (product.rating! < 3.5) {
      signals.lowRating = true; qualityRaw += 12;
    } else if (product.rating! >= 4.5 && (product.reviewCount ?? 0) >= 50) {
      // High rating backed by many reviews → strong positive quality signal.
      qualityRaw = Math.max(0, qualityRaw - 12);
    }
  }

  if (product.soldCount !== null && product.soldCount === 0) {
    signals.lowSoldCount = true; qualityRaw += 6;
  } else if ((product.soldCount ?? 0) >= 500) {
    // Many units sold → established, lower quality/scam concern.
    qualityRaw = Math.max(0, qualityRaw - 6);
    scamRaw    = Math.max(0, scamRaw - 4);
  }

  // Authenticity / verified-store badges (LazMall, Flagship, 100% Authentic) are
  // strong seller-trust positives — reduce the seller risk dimension.
  if (product.sellerBadges && product.sellerBadges.length > 0) {
    const trusted = product.sellerBadges.some(b => /lazmall|flagship|authentic|money back|free return/i.test(b));
    if (trusted) sellerRaw = Math.max(0, sellerRaw - 14);
  }

  // ── 7. Community reports by seller name ───────────────────────────────────
  if (product.sellerName && product.platform) {
    try {
      const rpts = await getCommunityReportCount(product.sellerName, product.platform);
      if (rpts > 0) {
        signals.communityReports = Math.max(signals.communityReports, rpts);
        const penalty = Math.min(rpts * 16, 55);
        scamRaw   += penalty;
        sellerRaw += Math.min(rpts * 10, 35);
        console.log(`[Scorer] Community reports: ${rpts} approved for seller "${product.sellerName}"`);
      }
    } catch { /* DB unavailable */ }
  }

  // ── 8. Keyword scan ───────────────────────────────────────────────────────
  const textToScan = [product.productName, product.sellerName, product.description]
    .filter(Boolean).join(' ').toLowerCase();

  if (textToScan) {
    try {
      const keywords = await getScamKeywords();
      let kwScore = 0;
      const found: string[] = [];
      for (const { keyword, weight } of keywords) {
        if (textToScan.includes(keyword.toLowerCase())) {
          found.push(keyword);
          kwScore += weight;
        }
      }
      signals.keywordsFound = found;
      signals.keywordScore  = kwScore;
      const kwPenalty = Math.min(kwScore, 42);
      scamRaw   += kwPenalty;
      sellerRaw += Math.min(kwScore * 0.3, 12);
    } catch { /* DB unavailable */ }
  }

  // ── 9. Low-confidence penalty → quality sub-score ─────────────────────────
  // Skip for url_only: the isUrlOnly penalty above already accounts for missing data.
  // Applying both would double-penalise and push quality too high artificially.
  if (conf < 60 && !isUrlOnly) {
    const penalty = Math.round((60 - conf) * 0.4);
    qualityRaw += penalty;
  }

  // ── 10. Clamp sub-scores ──────────────────────────────────────────────────
  const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

  const subScores: SubScores = {
    scamScore:    clamp(scamRaw),
    priceScore:   clamp(priceRaw),
    sellerScore:  clamp(sellerRaw),
    qualityScore: clamp(qualityRaw),
  };

  // ── Price anomaly cross-contribution ─────────────────────────────────────
  // When price is suspiciously low, it strongly implies a scam — not just a price issue.
  // Cross-pollinate into scamScore so the overall score reflects this correctly.
  if (signals.priceAnomaly && priceRaw >= 40) {
    scamRaw = Math.max(scamRaw, Math.round(priceRaw * 0.55));
    subScores.scamScore = clamp(scamRaw);
  }

  // ── 11. Overall score: weighted + max-floor ───────────────────────────────
  // Weighted: scam=35%, seller=30%, quality=20%, price=15%
  // PLUS: when any single dimension is in the high/medium range, the overall
  // score is floored to at least that range — prevents a single red flag being
  // "diluted away" by other low sub-scores.
  const weighted = Math.round(
    subScores.scamScore    * 0.35 +
    subScores.sellerScore  * 0.30 +
    subScores.qualityScore * 0.20 +
    subScores.priceScore   * 0.15,
  );

  // Max-sub-score floor: a single HIGH sub-score must elevate the overall level.
  // This prevents a genuine red flag being "diluted away" by low scores elsewhere.
  const maxSubScore = Math.max(subScores.scamScore, subScores.sellerScore, subScores.priceScore, subScores.qualityScore);
  const subFloor =
    maxSubScore >= 62 ? 62 :  // any sub-score is HIGH → overall must be High
    maxSubScore >= 45 ? 45 :  // any sub is medium-high → overall ≥ Medium
    maxSubScore >= 30 ? 30 :  // any sub is medium → overall ≥ medium-low
    0;

  // ── 12. Platform / data-quality floors ────────────────────────────────────
  let minScore = 0;
  if (isUrlOnly) {
    minScore = product.platform === 'facebook' ? 50 : 42;
  } else if (isPartial || conf < 30) {
    minScore = product.platform === 'facebook' ? 44 : 38;
  } else if (product.platform === 'facebook') {
    minScore = 32;
  } else if (product.platform === 'tiktok') {
    minScore = 30; // TikTok always at least medium — unverified seller ecosystem
  }

  const riskScore = Math.min(100, Math.max(minScore, subFloor, weighted));
  // Medium threshold lowered to 30: having any medium-range signal (score 30+)
  // is enough to warrant a caution rating, not just a blanket "low risk".
  const riskLevel: 'low' | 'medium' | 'high' =
    riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

  // ── 13. Consistency enforcement ───────────────────────────────────────────
  // Sub-scores must EXPLAIN the overall level — no "all Low" when overall is Medium/High.
  if (riskLevel !== 'low') {
    const allSubsBelow30 = subScores.scamScore < 30 && subScores.sellerScore < 30 &&
                           subScores.priceScore < 30 && subScores.qualityScore < 30;
    if (allSubsBelow30) {
      const targetFloor = riskLevel === 'high' ? 42 : 30;
      subScores.sellerScore  = Math.max(subScores.sellerScore,  targetFloor);
      subScores.qualityScore = Math.max(subScores.qualityScore, 28);
    }
  }

  if (riskLevel === 'high') {
    const anyHigh = subScores.scamScore >= 60 || subScores.sellerScore >= 60 ||
                    subScores.priceScore >= 60 || subScores.qualityScore >= 60;
    if (!anyHigh) {
      const maxSub = Math.max(subScores.scamScore, subScores.sellerScore, subScores.priceScore, subScores.qualityScore);
      if      (subScores.scamScore   === maxSub) subScores.scamScore   = Math.max(subScores.scamScore,   62);
      else if (subScores.sellerScore === maxSub) subScores.sellerScore = Math.max(subScores.sellerScore, 62);
      else if (subScores.priceScore  === maxSub) subScores.priceScore  = Math.max(subScores.priceScore,  62);
      else                                        subScores.qualityScore = Math.max(subScores.qualityScore, 62);
    }
  }

  // Per-dimension level helper for the requested diagnostic tags.
  const lvl = (s: number) => (s >= 60 ? 'HIGH' : s >= 30 ? 'MEDIUM' : 'LOW');
  const dataLevel =
    conf >= 60 ? 'CLEAR' : conf >= 30 ? 'LIMITED' : 'VERY_LIMITED';
  console.log(`[SCRAPER_MAPPED_RESULT] name="${product.productName}" price=${product.price} rating=${product.rating} reviews=${product.reviewCount} sold=${product.soldCount} seller="${product.sellerName}" conf=${conf}%`);
  console.log(`[PRICE_RISK_LEVEL] ${hasPrice ? lvl(subScores.priceScore) : 'NO_DATA'} (priceAnomaly=${signals.priceAnomalyPercent}%)`);
  console.log(`[QUALITY_RISK_LEVEL] ${hasReviews || hasRating ? lvl(subScores.qualityScore) : 'NO_DATA'}`);
  console.log(`[SELLER_RISK_LEVEL] ${hasSeller ? lvl(subScores.sellerScore) : 'NO_DATA'}`);
  console.log(`[SCAM_RISK_LEVEL] ${lvl(subScores.scamScore)}`);
  console.log(`[EXTRACTION_CONFIDENCE] ${conf}% (${dataLevel})`);

  console.log(
    `[Scorer] → ${riskScore}/100 (${riskLevel.toUpperCase()}) | weighted=${weighted} floor=${minScore}`,
    `| sub scam=${subScores.scamScore} price=${subScores.priceScore}`,
    `seller=${subScores.sellerScore} quality=${subScores.qualityScore}`,
    `| conf=${conf}% partial=${isPartial}`,
    `| platformRisk=${signals.platformRisk} newSeller=${signals.newSeller}`,
    `| reports=${signals.communityReports} priceAnomaly=${signals.priceAnomalyPercent}%`,
  );

  return { riskScore, riskLevel, signals, subScores };
}

// ─── Seller profile upsert ────────────────────────────────────────────────────

export async function upsertSellerProfile(product: ExtractedProduct, riskScore: number): Promise<void> {
  if (!product.sellerId || product.platform === 'other') return;

  const trustScore = Math.max(0, 100 - riskScore);

  await db.from('seller_profiles').upsert(
    {
      platform:     product.platform,
      seller_id:    product.sellerId,
      seller_name:  product.sellerName ?? 'Unknown',
      trust_score:  trustScore,
      last_checked: new Date().toISOString(),
      metadata: {
        rating:       product.rating,
        reviewCount:  product.reviewCount,
        soldCount:    product.soldCount,
      },
    },
    { onConflict: 'platform,seller_id', ignoreDuplicates: false },
  );
}
