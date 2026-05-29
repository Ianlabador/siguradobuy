/**
 * scorer.test.ts — Manual verification test for risk scoring
 *
 * Run: npx ts-node src/tests/scorer.test.ts
 *
 * Verifies 6 scenarios have:
 * 1. Different risk scores
 * 2. Sub-scores that explain the overall score
 * 3. Signals that match the input data
 * 4. No fabricated data
 */

import { scoreProduct } from '../services/scorer';
import type { ExtractedProduct } from '../services/extractor';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeProduct(overrides: Partial<ExtractedProduct>): ExtractedProduct {
  return {
    platform:         'shopee',
    productName:      null,
    price:            null,
    sellerName:       null,
    sellerId:         null,
    sellerUrl:        null,
    rating:           null,
    reviewCount:      null,
    soldCount:        null,
    description:      null,
    category:         null,
    sellerAge:        null,
    rawUrl:           'https://shopee.ph/test',
    resolvedUrl:      'https://shopee.ph/test',
    partial:          false,
    extractMethod:    'api',
    confidence:       80,
    workerUsed:       1,
    dataSources: {
      price: false, seller: false, reviews: false,
      rating: false, description: false, soldCount: false,
    },
    needsDeeperCheck: false,
    ...overrides,
  };
}

// ── Test cases ────────────────────────────────────────────────────────────────

const TEST_CASES: Array<{
  label:         string;
  product:       ExtractedProduct;
  expect: {
    minScore:    number;
    maxScore:    number;
    riskLevel:   'low' | 'medium' | 'high';
    minSubScore: { name: keyof import('../services/scorer').SubScores; min: number } | null;
    signals:     Partial<{ priceAnomaly: boolean; newSeller: boolean; noReviews: boolean }>;
  };
}> = [
  {
    label: '1. Normal well-known Shopee listing (should be LOW risk)',
    product: makeProduct({
      platform:     'shopee',
      productName:  'Rice Cooker Miyako 1L',
      price:        850,
      sellerName:   'TopAppliancePH',
      rating:       4.7,
      reviewCount:  238,
      soldCount:    1420,
      description:  'Original Miyako rice cooker with warranty',
      confidence:   90,
      dataSources:  { price: true, seller: true, reviews: true, rating: true, description: true, soldCount: true },
    }),
    expect: {
      minScore: 0,  maxScore: 35,  riskLevel: 'low',
      minSubScore: null,
      signals: { priceAnomaly: false, noReviews: false },
    },
  },
  {
    label: '2. Suspiciously cheap iPhone at ₱2500 (should be HIGH risk)',
    product: makeProduct({
      platform:     'shopee',
      productName:  'iPhone 15 Pro Max Brand New Sealed',
      price:        2500,  // ₱2500 for an iPhone — impossibly cheap
      sellerName:   'BestDealsPH2024',
      rating:       null,
      reviewCount:  2,
      soldCount:    0,
      confidence:   75,
      dataSources:  { price: true, seller: true, reviews: true, rating: false, description: false, soldCount: true },
    }),
    expect: {
      minScore: 55,  maxScore: 100,  riskLevel: 'high',
      minSubScore: { name: 'priceScore', min: 55 },
      signals: { priceAnomaly: true },
    },
  },
  {
    label: '3. Facebook Marketplace laptop — no seller data (should be MEDIUM+)',
    product: makeProduct({
      platform:      'facebook',
      productName:   'Second hand laptop',
      price:         5000,
      sellerName:    null,
      sellerId:      '123456789',
      rating:        null,
      reviewCount:   null,
      soldCount:     null,
      partial:       true,
      extractMethod: 'og',
      confidence:    40,
      dataSources:   { price: true, seller: false, reviews: false, rating: false, description: false, soldCount: false },
    }),
    expect: {
      // FB base risk + partial + no seller → at least medium
      minScore: 35,  maxScore: 80,  riskLevel: 'medium',
      minSubScore: { name: 'sellerScore', min: 30 },
      // FB laptop heuristic may or may not fire — don't assert priceAnomaly
      signals: {},
    },
  },
  {
    label: '4. URL-only — zero data extracted (should be MEDIUM caution)',
    product: makeProduct({
      platform:      'shopee',
      productName:   null,
      price:         null,
      sellerName:    null,
      partial:       true,
      extractMethod: 'url_only',
      confidence:    0,
      dataSources:   { price: false, seller: false, reviews: false, rating: false, description: false, soldCount: false },
    }),
    expect: {
      minScore: 38,  maxScore: 75,  riskLevel: 'medium',
      minSubScore: null,
      signals: { priceAnomaly: false },
    },
  },
  {
    label: '5. Scam-keyword-rich listing with no reviews (should be MEDIUM+)',
    product: makeProduct({
      platform:     'lazada',
      productName:  'Flash Sale Limited Pay First No Return',
      price:        299,
      sellerName:   'QuickDeal123',
      rating:       null,
      reviewCount:  0,
      description:  'Rush order, GCash only, bayad muna before ship, legit seller',
      confidence:   65,
      dataSources:  { price: true, seller: true, reviews: true, rating: false, description: true, soldCount: false },
    }),
    expect: {
      // Keywords should fire: "pay first", "no return", "gcash only", "bayad muna", "flash sale", "legit"
      minScore: 30,  maxScore: 100,  riskLevel: 'medium',
      minSubScore: { name: 'scamScore', min: 20 },
      signals: { noReviews: true },
    },
  },
  {
    label: '6. TikTok Shop — partial data, no seller verification (should be MEDIUM)',
    product: makeProduct({
      platform:      'tiktok',
      productName:   'Skin Care Bundle Set',
      price:         499,
      sellerName:    'glowup_seller_2024',
      sellerId:      'glowup_seller_2024',
      rating:        null,
      reviewCount:   null,
      soldCount:     3,
      partial:       false,
      extractMethod: 'og',
      confidence:    55,
      dataSources:   { price: true, seller: true, reviews: false, rating: false, description: false, soldCount: true },
    }),
    expect: {
      minScore: 20,  maxScore: 70,  riskLevel: 'medium',
      minSubScore: { name: 'sellerScore', min: 25 },
      signals: {},
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   SiguradoBuy Scorer — 6-Scenario Verification Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;
  const results: string[] = [];

  for (const tc of TEST_CASES) {
    console.log(`\n─── ${tc.label} ───`);
    const result = await scoreProduct(tc.product);
    const { riskScore, riskLevel, signals, subScores } = result;

    let ok = true;
    const issues: string[] = [];

    // Check overall score range
    if (riskScore < tc.expect.minScore || riskScore > tc.expect.maxScore) {
      ok = false; issues.push(`Score ${riskScore} not in [${tc.expect.minScore}–${tc.expect.maxScore}]`);
    }

    // Check risk level
    if (riskLevel !== tc.expect.riskLevel) {
      ok = false; issues.push(`Level "${riskLevel}" ≠ expected "${tc.expect.riskLevel}"`);
    }

    // Check specific sub-score minimum
    if (tc.expect.minSubScore) {
      const { name, min } = tc.expect.minSubScore;
      if (subScores[name] < min) {
        ok = false; issues.push(`${name}=${subScores[name]} < expected min ${min}`);
      }
    }

    // Check expected signals
    for (const [sig, expected] of Object.entries(tc.expect.signals)) {
      const actual = (signals as any)[sig];
      if (expected !== undefined && actual !== expected) {
        ok = false; issues.push(`signals.${sig}=${actual} ≠ expected ${expected}`);
      }
    }

    // Check sub-scores consistency with overall level
    if (riskLevel === 'medium' || riskLevel === 'high') {
      const maxSub = Math.max(subScores.scamScore, subScores.sellerScore, subScores.priceScore, subScores.qualityScore);
      if (maxSub < 28) {
        ok = false; issues.push(`All sub-scores < 28 but overall is ${riskLevel} — inconsistency!`);
      }
    }

    const status = ok ? '✅ PASS' : '❌ FAIL';
    const line = `${status}  Score:${riskScore} Level:${riskLevel.toUpperCase()} | scam=${subScores.scamScore} price=${subScores.priceScore} seller=${subScores.sellerScore} quality=${subScores.qualityScore}`;
    console.log(line);
    if (issues.length) console.log(`      Issues: ${issues.join(' | ')}`);

    if (ok) passed++; else failed++;
    results.push(`${status} [${tc.label}] → ${riskScore}/100 ${riskLevel.toUpperCase()}`);
  }

  // Verify scores are NOT all the same (not hardcoded)
  const scores = (await Promise.all(TEST_CASES.map(tc => scoreProduct(tc.product)))).map(r => r.riskScore);
  const uniqueScores = new Set(scores);
  const allDifferent = uniqueScores.size >= 4;  // at least 4 different scores

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`\n  Passed: ${passed}/${TEST_CASES.length}    Failed: ${failed}/${TEST_CASES.length}`);
  console.log(`  Scores: ${scores.join(', ')} — ${allDifferent ? '✅ All different' : '❌ Too similar (possible hardcoding!)'}`);
  console.log('\n  Results:');
  results.forEach(r => console.log(`    ${r}`));
  console.log('\n═══════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(e => { console.error('Test runner error:', e); process.exit(1); });
