import OpenAI from 'openai';
import type { ExtractedProduct } from './extractor';
import type { ScoringResult } from './scorer';

// ─── Provider config (OpenAI) ─────────────────────────────────────────────────
export const AI_PROVIDER = 'openai';
export const AI_MODEL    = 'gpt-4o-mini';

let openai: OpenAI | null = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export function isAIConfigured(): boolean {
  return !!openai;
}

/** Safe AI status for the /api/ai/status route — never exposes the key. */
export function getAIStatus(): { configured: boolean; provider: string; model?: string; proRequired: boolean; reason?: string } {
  if (!openai) {
    return { configured: false, provider: AI_PROVIDER, proRequired: true, reason: 'OPENAI_API_KEY missing' };
  }
  return { configured: true, provider: AI_PROVIDER, model: AI_MODEL, proRequired: true };
}

const SYSTEM_PROMPT = `You are SiguradoBuy's risk analysis assistant. You help Filipino online shoppers understand if a product or seller shows risk signals before they buy.

YOUR RULES:
- NEVER say a product is "100% safe" or "definitely a scam" — always use risk language
- Use phrases like: "shows signs of", "may indicate", "be cautious", "we detected"
- Write in simple conversational Filipino-English (Taglish is OK and preferred)
- Keep your summary under 100 words
- List specific risk factors as bullet points — be concrete, not vague
- End with ONE clear action the buyer should take
- If data is limited, acknowledge it: "Based on available data..."
- Never mention competitors or make legal claims
- Be helpful and empathetic — these are real people trying to avoid scams

HOW TO CLASSIFY CONCERNS (important — do NOT lump everything as "scam"):
- SCAM risk = fraud signals only: community scam reports, scam keywords, fake/very new seller, or impossibly "too good to be true" pricing. Only raise scam concern when these are present.
- PRICE / VALUE = the item may be OVERPRICED (or suspiciously cheap). Only mention overpricing when a price anomaly/baseline comparison is provided.
- QUALITY = the product may be DEFECTIVE, low quality, or "not as described". A LOW rating or poor/few reviews points to a QUALITY/VALUE problem — describe it that way (e.g. "mababa ang rating, baka depektibo o hindi tulad ng nasa picture"), NOT as a scam.
- SELLER TRUST = how trustworthy the seller is (account age, reports, verification).
- A low rating does NOT mean the seller is a scammer. It usually means the PRODUCT may be defective or overpriced. Be precise so you never wrongly accuse an honest seller of being a scammer.
- A high rating backed by many reviews / high sold count is a POSITIVE trust + quality signal — say so.

UNVERIFIED LISTINGS:
- If "unverified" is YES, you could NOT read enough of the listing to judge it. Do NOT give a scam, price, or quality verdict.
- Say plainly that the listing could not be verified, that this is NOT a sign the seller is bad, and advise the buyer to check the seller's reviews/ratings and use COD/meet-up if possible.

EVIDENCE RULES (do NOT break these):
- Use ONLY the data and signals provided. Never invent facts.
- If a field is "NOT FOUND" or "review data not available", do NOT claim it exists OR that it's missing as a fault — say data is limited.
- Do NOT claim reviews exist if review data is not available.
- Do NOT call a product a scam unless scam signals or community reports are present.
- Do NOT call a product overpriced unless a price anomaly / baseline comparison is provided — if there's no comparison data, say price could not be compared.
- If review snippets are missing, judge quality only from rating + review count, and say so.
- If confidence is low, state that the analysis is limited.
- Cover these dimensions in the summary when data allows: (1) scam risk, (2) price/overprice, (3) product quality (defective/not as described), (4) seller trust, (5) a final recommendation.

OUTPUT FORMAT (strict JSON):
{
  "summary": "Plain language explanation in Taglish (under 100 words)",
  "factors": ["Factor 1", "Factor 2", "..."],
  "recommendation": "One actionable suggestion"
}`;

export interface AiAnalysis {
  summary: string;
  factors: string[];
  recommendation: string;
  tokensUsed?: number | null;
  status?: 'success' | 'fallback' | 'error';
}

function buildUserPrompt(product: ExtractedProduct, scoring: ScoringResult): string {
  const { signals, subScores } = scoring;

  // Build a clear data availability picture — never let AI hallucinate what we don't have
  const dataFound: string[] = [];
  const dataMissing: string[] = [];
  if (product.productName)  dataFound.push('product title');   else dataMissing.push('product title');
  if (product.price)        dataFound.push(`price (₱${product.price?.toLocaleString()})`); else dataMissing.push('price');
  if (product.sellerName)   dataFound.push(`seller (${product.sellerName})`); else dataMissing.push('seller name');
  if (product.rating != null) dataFound.push(`rating (${product.rating}/5)`); else dataMissing.push('rating');
  if (product.reviewCount != null) dataFound.push(`reviews (${product.reviewCount})`); else dataMissing.push('review count');
  if (product.soldCount != null) dataFound.push(`sold count (${product.soldCount})`);

  // Interpret rating/reviews as a QUALITY/VALUE signal (defective / not-as-described / overpriced),
  // NOT as a scam signal.
  let qualitySignal = 'Rating/review data not available — cannot judge product quality';
  if (product.rating != null) {
    if (product.rating < 2.5) qualitySignal = `LOW rating (${product.rating}/5) — buyers report problems; product may be defective, poor quality, or not as described`;
    else if (product.rating < 3.5) qualitySignal = `Below-average rating (${product.rating}/5) — some buyers unhappy; possible quality/value issues`;
    else if (product.rating >= 4.5 && (product.reviewCount ?? 0) >= 50) qualitySignal = `Strong rating (${product.rating}/5 from ${product.reviewCount} reviews) — positive quality & trust signal`;
    else qualitySignal = `Rating ${product.rating}/5${product.reviewCount != null ? ` from ${product.reviewCount} reviews` : ''}`;
  } else if (product.reviewCount === 0) {
    qualitySignal = 'ZERO reviews — no buyer feedback yet to judge product quality';
  }

  const data = {
    platform: product.platform,
    unverified:      scoring.unverified ? 'YES — we could NOT read enough of this listing to judge it' : 'No',
    product_name:    product.productName ?? 'NOT FOUND',
    price:           product.price ? `₱${product.price.toLocaleString()}` : 'NOT FOUND',
    seller_name:     product.sellerName ?? 'NOT FOUND',
    risk_score:      `${scoring.riskScore}/100`,
    risk_level:      scoring.riskLevel.toUpperCase(),
    confidence:      `${product.confidence ?? 0}%`,
    // Sub-scores — explicitly tell AI what each dimension looks like
    sub_scores: {
      scam_risk:    `${subScores.scamScore}/100 (${subScores.scamScore >= 60 ? 'HIGH' : subScores.scamScore >= 30 ? 'MEDIUM' : 'LOW'}) — FRAUD only`,
      price_risk:   `${subScores.priceScore}/100 (${subScores.priceScore >= 60 ? 'HIGH' : subScores.priceScore >= 30 ? 'MEDIUM' : 'LOW'}) — OVERPRICED / too-cheap`,
      quality_risk: `${subScores.qualityScore}/100 (${subScores.qualityScore >= 60 ? 'HIGH' : subScores.qualityScore >= 30 ? 'MEDIUM' : 'LOW'}) — DEFECTIVE / not as described`,
      seller_risk:  `${subScores.sellerScore}/100 (${subScores.sellerScore >= 60 ? 'HIGH' : subScores.sellerScore >= 30 ? 'MEDIUM' : 'LOW'}) — SELLER trust`,
    },
    // Signals — be explicit about what fired and what didn't
    signals: {
      price_anomaly:        signals.priceAnomaly
        ? `YES — ${signals.priceAnomalyPercent != null ? `${signals.priceAnomalyPercent}% vs market average` : 'unusual price detected'} (treat as PRICE/VALUE, only a scam clue if extremely cheap)`
        : 'Not detected',
      product_quality:      qualitySignal,
      new_seller:           signals.newSeller
        ? `YES — account is ${signals.sellerAgeDays != null ? `${signals.sellerAgeDays} days old` : 'very new'}`
        : 'Not detected',
      reviews_status:       product.reviewCount == null
        ? 'Review data NOT available — do not claim reviews exist or are missing'
        : product.reviewCount === 0
          ? 'ZERO reviews confirmed'
          : `Has ${product.reviewCount} reviews`,
      low_rating:           signals.lowRating ? `YES — rating is ${product.rating}/5 (QUALITY concern: defective / not as described, NOT scam)` : 'Not detected',
      community_reports:    signals.communityReports > 0
        ? `YES — ${signals.communityReports} approved report(s) for this seller (REAL scam signal)`
        : 'None found',
      suspicious_keywords:  signals.keywordsFound.length > 0
        ? `YES — "${signals.keywordsFound.slice(0, 3).join('", "')}" detected (scam clue)`
        : 'None detected',
      platform_risk:        signals.platformRisk ? `YES — ${product.platform} has higher baseline fraud risk` : 'No',
      partial_data:         signals.partialData ? 'YES — limited data was available for this listing' : 'No',
    },
    data_found:   dataFound,
    data_missing: dataMissing,
  };

  return `Analyze this Philippine online marketplace listing and provide your risk explanation.
Classify each concern correctly: scam (fraud) vs overpriced (price/value) vs defective/not-as-described (quality) vs seller trust.
A low rating is a QUALITY/VALUE issue (possibly defective or overpriced), NOT proof of a scam.
Be specific about what you found and what you didn't find. Do NOT make up data that is listed as "NOT FOUND".
If "unverified" is YES, say you couldn't verify the listing and give safe general advice — no scam/quality verdict.

${JSON.stringify(data, null, 2)}

Respond ONLY with valid JSON matching the output format in your instructions.
Base your summary and factors ONLY on the signals and data shown above — never invent data.`;
}

export async function analyzeWithAI(
  product: ExtractedProduct,
  scoring: ScoringResult
): Promise<AiAnalysis> {
  const fallback: AiAnalysis = scoring.unverified
    ? {
        summary: 'Hindi namin ma-verify ang listing na ito dahil kulang ang nakuhang detalye sa link. HINDI ito senyales na masama ang seller — basta hindi lang namin ma-check. Tingnan mo mismo ang rating, reviews, at profile ng seller bago magbayad.',
        factors: buildFactorsFallback(scoring),
        recommendation: 'Gamitin ang Cash on Delivery (COD) o meet-up kung pwede, at i-verify ang seller bago magpadala ng pera.',
      }
    : {
        summary: `Ang listing na ito ay may risk score na ${scoring.riskScore}/100. ${
          scoring.riskLevel === 'high'
            ? 'Maraming warning signs ang nakita — mag-ingat bago mag-bayad.'
            : scoring.riskLevel === 'medium'
            ? 'May ilang bagay na dapat i-verify bago bumili.'
            : 'Mukhang okay ang listing na ito, pero mag-ingat pa rin.'
        }`,
        factors: buildFactorsFallback(scoring),
        recommendation:
          scoring.riskLevel === 'high'
            ? 'Huwag muna mag-bayad. I-verify muna ang seller sa official channels.'
            : 'Basahin ang mga reviews at makipag-usap sa seller bago bumili.',
      };

  if (!openai) {
    console.warn('[AI] OPENAI_API_KEY not set — using rule-based fallback');
    return { ...fallback, tokensUsed: null, status: 'fallback' };
  }

  try {
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 400,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(product, scoring) },
      ],
    });

    const tokensUsed = response.usage?.total_tokens ?? null;
    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as AiAnalysis;

    if (!parsed.summary || !Array.isArray(parsed.factors) || !parsed.recommendation) {
      console.warn('[AI] Malformed AI response — using fallback');
      return { ...fallback, tokensUsed, status: 'fallback' };
    }

    console.log(`[AI] OpenAI ${AI_MODEL} ok — tokens:${tokensUsed}`);
    return { ...parsed, tokensUsed, status: 'success' };
  } catch (e: any) {
    // Rate limit, timeout, API error, network, malformed — never crash, never expose the key.
    console.error('[AI] OpenAI call failed (using fallback):', e?.message ?? 'unknown error');
    return { ...fallback, tokensUsed: null, status: 'error' };
  }
}

function buildFactorsFallback(scoring: ScoringResult): string[] {
  const { signals } = scoring;
  const factors: string[] = [];

  // Unverified → don't list risk "factors", explain we couldn't read it.
  if (scoring.unverified) {
    factors.push("We couldn't read enough details from this link to verify the listing");
    factors.push('This is NOT a sign the seller is bad — only that we could not check it');
    factors.push('Check the seller’s rating, reviews, and profile yourself before paying');
    return factors;
  }

  // SCAM (fraud) signals
  if (signals.communityReports > 0) {
    factors.push(`${signals.communityReports} community scam report(s) found for this seller`);
  }
  if (signals.keywordsFound.length > 0) {
    factors.push(`Suspicious language detected: "${signals.keywordsFound.slice(0, 3).join('", "')}"`);
  }
  if (signals.newSeller) {
    const age = signals.sellerAgeDays !== null ? `${signals.sellerAgeDays} days` : 'very new';
    factors.push(`Seller account is ${age} old`);
  }

  // PRICE / VALUE
  if (signals.priceAnomaly && signals.priceAnomalyPercent) {
    const pct = signals.priceAnomalyPercent;
    factors.push(
      pct > 0
        ? `Price is ${pct}% below typical market price — verify it's genuine, not too-good-to-be-true`
        : `Price is ${Math.abs(pct)}% above typical market price — may be overpriced`,
    );
  }

  // QUALITY (defective / not as described) — from ratings/reviews
  if (signals.lowRating) {
    factors.push('Low buyer rating — product may be defective or not as described');
  } else if (signals.noReviews) {
    factors.push('No buyer reviews yet — product quality is unproven');
  }

  if (signals.partialData) {
    factors.push('Limited product data available — manual verification recommended');
  }
  if (factors.length === 0) {
    factors.push('No major risk signals detected at this time');
  }

  return factors;
}
