/**
 * apify.ts — Worker 2: Apify fallback scraper
 *
 * Uses Apify residential proxy to retry platform scrapes that failed
 * or returned low-confidence data. The proxy rotates real IPs so
 * bot-detection is bypassed without duplicating scraping logic.
 *
 * APIFY_API_TOKEN is read server-side only — never sent to mobile.
 */

import axios, { type AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import type { Platform } from './extractor';

// ─── Proxy client ─────────────────────────────────────────────────────────────

function makeApifyClient(timeoutMs = 18000): AxiosInstance | null {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return null;

  return axios.create({
    timeout: timeoutMs,
    proxy: {
      protocol: 'http',
      host:     'proxy.apify.com',
      port:     8000,
      auth:     { username: 'auto', password: token },
    },
    headers: {
      'User-Agent':    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-PH,en;q=0.9',
    },
  });
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface ApifyResult {
  productName:  string | null;
  price:        number | null;
  sellerName:   string | null;
  sellerId:     string | null;
  rating:       number | null;
  reviewCount:  number | null;
  soldCount:    number | null;
  description:  string | null;
  confidence:   number;
}

// ─── Shared helpers (price / reviews / rating / description) ───────────────────

// Parse compact counts: "3.9K" → 3900, "1.2M" → 1_200_000, "350 sold" → 350.
function parseCompactNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).replace(/,/g, '').match(/([\d.]+)\s*([KkMm]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'K') return Math.round(n * 1_000);
  if (unit === 'M') return Math.round(n * 1_000_000);
  return Math.round(n);
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1] != null) return m[1];
  }
  return null;
}

interface JsonLdProduct {
  productName: string | null;
  price:       number | null;
  rating:      number | null;
  reviewCount: number | null;
  description: string | null;
  sellerName:  string | null;
}

// Pull Product data from any JSON-LD blocks on the page (price, rating, reviews, desc).
function extractJsonLd($: cheerio.CheerioAPI): JsonLdProduct {
  const out: JsonLdProduct = { productName: null, price: null, rating: null, reviewCount: null, description: null, sellerName: null };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? '');
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item['@type'] === 'Product' || item.name) {
          out.productName = out.productName ?? item.name ?? null;
          const rp = item.offers?.price ?? item.offers?.lowPrice ?? item.price;
          if (rp && out.price == null) out.price = typeof rp === 'string' ? parseFloat(String(rp).replace(/,/g, '')) : rp;
          if (item.aggregateRating?.ratingValue && out.rating == null) out.rating = parseFloat(item.aggregateRating.ratingValue);
          if (out.reviewCount == null) {
            const rc = item.aggregateRating?.reviewCount ?? item.aggregateRating?.ratingCount;
            if (rc != null) out.reviewCount = parseInt(String(rc).replace(/,/g, ''), 10);
          }
          if (item.description && out.description == null) out.description = String(item.description).slice(0, 600);
          out.sellerName = out.sellerName ?? item.brand?.name ?? item.seller?.name ?? null;
        }
      }
    } catch { /* skip */ }
  });

  return out;
}

// og: meta description fallback.
function ogDescription($: cheerio.CheerioAPI): string | null {
  const d = $('meta[property="og:description"]').attr('content') ?? $('meta[name="description"]').attr('content') ?? null;
  return d ? d.slice(0, 600) : null;
}

function countFilled(...vals: Array<unknown>): number {
  return vals.filter(v => v != null && v !== '').length;
}

// ─── Shopee via Apify proxy ───────────────────────────────────────────────────

async function scrapeShopeeApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  // Try Shopee API first through proxy — richest source (price, rating, reviews, sold, desc)
  const apiMatch = url.match(/i\.(\d+)\.(\d+)/);
  if (apiMatch) {
    const shopId = apiMatch[1];
    const itemId = apiMatch[2];
    try {
      const res = await client.get(
        `https://shopee.ph/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
        {
          headers: {
            'Referer':          'https://shopee.ph/',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept':           'application/json',
          },
        },
      );
      const d = res.data?.data;
      if (d?.name) {
        const ratingData = d.item_rating;
        const price = d.price != null ? d.price / 100000 : (d.price_min != null ? d.price_min / 100000 : null);
        console.log(`[Apify] Shopee API: "${d.name}" ₱${price} rating:${ratingData?.rating_star} reviews:${ratingData?.rating_count?.[0]}`);
        return {
          productName: d.name,
          price,
          sellerName:  d.shop_name ?? null,
          sellerId:    shopId,
          rating:      ratingData?.rating_star ?? null,
          reviewCount: ratingData?.rating_count?.[0] ?? null,
          soldCount:   d.historical_sold ?? d.sold ?? null,
          description: (d.description ?? '').slice(0, 600) || null,
          confidence:  90,
        };
      }
    } catch { /* fall through to HTML */ }
  }

  // Fallback: HTML scrape via proxy — now also pulls reviews/rating/description via JSON-LD
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);
    const jsonLd = extractJsonLd($);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    const sellerMatch = url.match(/shopee\.ph\/([^\/\?]+)\//);

    const productName = jsonLd.productName ?? ogTitle;
    const price       = jsonLd.price ?? (ogPrice ? parseFloat(ogPrice) : null);
    const sellerName  = jsonLd.sellerName ?? sellerMatch?.[1]?.replace(/-/g, ' ') ?? null;
    const description = jsonLd.description ?? ogDescription($);

    if (!productName && !price) return null;
    const conf = 30 + countFilled(price, jsonLd.rating, jsonLd.reviewCount, description) * 12;
    return {
      productName, price, sellerName, sellerId: sellerMatch?.[1] ?? null,
      rating: jsonLd.rating, reviewCount: jsonLd.reviewCount, soldCount: null,
      description, confidence: Math.min(conf, 80),
    };
  } catch {
    return null;
  }
}

// ─── Lazada via Apify proxy ───────────────────────────────────────────────────

async function scrapeLazadaApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);
    const html: string = typeof res.data === 'string' ? res.data : '';
    const jsonLd = extractJsonLd($);

    let productName = jsonLd.productName;
    let price       = jsonLd.price;
    let sellerName  = jsonLd.sellerName;
    let rating      = jsonLd.rating;
    let reviewCount = jsonLd.reviewCount;
    let soldCount: number | null = null;
    let description = jsonLd.description ?? ogDescription($);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    productName = productName ?? (ogTitle ? ogTitle.replace(/\s*[-|:]\s*Lazada.*$/i, '').trim() : null);
    price = price ?? (ogPrice ? parseFloat(ogPrice) : null);

    // Embedded PDP data — field-level regex (robust against Lazada's giant JSON blob)
    const scriptText = html || $('script').map((_, el) => $(el).html() ?? '').get().join(' ');

    if (price == null) {
      const pr = firstMatch(scriptText, [/"salePrice"\s*:\s*"?([\d.,]+)"?/, /"price"\s*:\s*"?([\d.,]+)"?/, /"priceNumber"\s*:\s*"?([\d.,]+)"?/]);
      if (pr) price = parseFloat(pr.replace(/,/g, ''));
    }
    if (rating == null) {
      const rt = firstMatch(scriptText, [/"ratingScore"\s*:\s*"?([\d.]+)"?/, /"averageRating"\s*:\s*"?([\d.]+)"?/, /"average"\s*:\s*"?([\d.]+)"?/]);
      if (rt) { const v = parseFloat(rt); if (v > 0 && v <= 5) rating = v; }
    }
    if (reviewCount == null) {
      const rc = firstMatch(scriptText, [/"totalReviews"\s*:\s*"?([\d,]+)"?/, /"reviewCount"\s*:\s*"?([\d,]+)"?/, /"ratingCount"\s*:\s*"?([\d,]+)"?/]);
      if (rc) reviewCount = parseInt(rc.replace(/,/g, ''), 10);
    }
    if (soldCount == null) {
      const sc = firstMatch(scriptText, [/"itemSoldCntShow"\s*:\s*"([^"]+)"/, /"soldCount"\s*:\s*"?([\d.,KkMm]+)"?/, /"sold"\s*:\s*"?([\d.,KkMm]+)"?/]);
      if (sc) soldCount = parseCompactNumber(sc);
    }
    if (!sellerName) {
      sellerName = firstMatch(scriptText, [/"sellerName"\s*:\s*"([^"]+)"/, /"storeName"\s*:\s*"([^"]+)"/, /"shopName"\s*:\s*"([^"]+)"/]);
    }

    if (!productName && !price) return null;
    const conf = countFilled(productName, price, sellerName, rating, reviewCount, soldCount, description) * 13;
    console.log(`[Apify] Lazada: "${productName}" ₱${price} rating:${rating} reviews:${reviewCount} sold:${soldCount}`);
    return { productName, price, sellerName, sellerId: null, rating, reviewCount, soldCount, description, confidence: Math.min(conf, 85) };
  } catch {
    return null;
  }
}

// ─── TikTok via Apify proxy ───────────────────────────────────────────────────

async function scrapeTikTokApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);
    const jsonLd = extractJsonLd($);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogDesc  = ogDescription($);

    const sellerMatch = url.match(/@([^\/\?]+)/);
    const sellerName = sellerMatch?.[1]?.replace(/_/g, ' ') ?? null;

    let price: number | null = jsonLd.price;
    if (price == null) {
      const priceMatch = [ogTitle, ogDesc].filter(Boolean).join(' ').match(/₱[\s]*([\d,]+\.?\d*)/);
      if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));
    }

    const productName = jsonLd.productName ?? (ogTitle
      ? ogTitle.replace(/₱[\s]*([\d,]+\.?\d*)/, '').replace(/\s+/g, ' ').trim() || ogTitle
      : null);

    if (!productName) return null;
    const conf = 30 + countFilled(price, jsonLd.rating, jsonLd.reviewCount, ogDesc) * 8;
    return {
      productName, price, sellerName, sellerId: sellerMatch?.[1] ?? null,
      rating: jsonLd.rating, reviewCount: jsonLd.reviewCount, soldCount: null,
      description: jsonLd.description ?? ogDesc, confidence: Math.min(conf, 70),
    };
  } catch {
    return null;
  }
}

// ─── Facebook via Apify proxy ─────────────────────────────────────────────────

async function scrapeFacebookApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    });
    const $ = cheerio.load(res.data);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogDesc  = ogDescription($);

    let price: number | null = null;
    const priceMatch = [ogDesc, ogTitle].filter(Boolean).join(' ').match(/₱\s*([\d,]+\.?\d*)/);
    if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));

    const productName = ogTitle?.replace(/\s*-\s*Facebook.*$/, '').trim() ?? null;
    const listingId = url.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;

    // Facebook Marketplace does not expose ratings/reviews publicly — leave null (honest).
    if (!productName && !price) return null;
    const conf = 25 + countFilled(price, ogDesc) * 10;
    return {
      productName, price, sellerName: null, sellerId: listingId,
      rating: null, reviewCount: null, soldCount: null,
      description: ogDesc, confidence: Math.min(conf, 50),
    };
  } catch {
    return null;
  }
}

// ─── Generic via Apify proxy ──────────────────────────────────────────────────

async function scrapeGenericApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);
    const jsonLd = extractJsonLd($);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    const ogSite  = $('meta[property="og:site_name"]').attr('content') ?? null;

    const productName = jsonLd.productName ?? ogTitle;
    const price       = jsonLd.price ?? (ogPrice ? parseFloat(ogPrice) : null);

    if (!productName && !price) return null;
    const conf = 20 + countFilled(price, jsonLd.rating, jsonLd.reviewCount, jsonLd.description) * 10;
    return {
      productName, price, sellerName: jsonLd.sellerName ?? ogSite,
      sellerId: null, rating: jsonLd.rating, reviewCount: jsonLd.reviewCount,
      soldCount: null, description: jsonLd.description ?? ogDescription($), confidence: Math.min(conf, 60),
    };
  } catch {
    return null;
  }
}

// ─── Main: run Apify fallback ─────────────────────────────────────────────────

export async function runApifyFallback(url: string, resolvedUrl: string, platform: Platform): Promise<ApifyResult | null> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.log('[Apify] APIFY_API_TOKEN not set — skipping fallback');
    return null;
  }

  const client = makeApifyClient();
  if (!client) return null;

  console.log(`[Apify] Worker 2 starting for ${platform}: ${resolvedUrl}`);
  const startMs = Date.now();

  try {
    let result: ApifyResult | null = null;

    if (platform === 'shopee')   result = await scrapeShopeeApify(resolvedUrl, client);
    else if (platform === 'lazada')   result = await scrapeLazadaApify(resolvedUrl, client);
    else if (platform === 'tiktok')   result = await scrapeTikTokApify(resolvedUrl, client);
    else if (platform === 'facebook') result = await scrapeFacebookApify(resolvedUrl, client);
    else                               result = await scrapeGenericApify(resolvedUrl, client);

    console.log(`[Apify] Worker 2 done in ${Date.now() - startMs}ms — confidence:${result?.confidence ?? 0} name:"${result?.productName}" price:${result?.price} rating:${result?.rating} reviews:${result?.reviewCount}`);
    return result;
  } catch (e: any) {
    console.error(`[Apify] Worker 2 failed: ${e.message}`);
    return null;
  }
}
