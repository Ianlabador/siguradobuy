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

// ─── Shopee via Apify proxy ───────────────────────────────────────────────────

async function scrapeShopeeApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  // Try Shopee API first through proxy
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
        return {
          productName: d.name,
          price:       d.price != null ? d.price / 100000 : null,
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

  // Fallback: HTML scrape via proxy
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    const sellerMatch = url.match(/shopee\.ph\/([^\/\?]+)\//);

    const productName = ogTitle;
    const price = ogPrice ? parseFloat(ogPrice) : null;
    const sellerName = sellerMatch?.[1]?.replace(/-/g, ' ') ?? null;

    if (!productName && !price) return null;
    return { productName, price, sellerName, sellerId: sellerMatch?.[1] ?? null, rating: null, reviewCount: null, soldCount: null, description: null, confidence: 45 };
  } catch {
    return null;
  }
}

// ─── Lazada via Apify proxy ───────────────────────────────────────────────────

async function scrapeLazadaApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    let productName: string | null = null;
    let price: number | null = null;
    let sellerName: string | null = null;
    let rating: number | null = null;
    let reviewCount: number | null = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '');
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item['@type'] === 'Product' || item.name) {
            productName = item.name ?? productName;
            const rawPrice = item.offers?.price ?? item.price;
            if (rawPrice) price = typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(/,/g, '')) : rawPrice;
            rating = item.aggregateRating?.ratingValue ?? rating;
            reviewCount = item.aggregateRating?.reviewCount ?? reviewCount;
            sellerName = item.brand?.name ?? item.seller?.name ?? sellerName;
          }
        }
      } catch { /* skip */ }
    });

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    productName = productName ?? ogTitle;
    price = price ?? (ogPrice ? parseFloat(ogPrice) : null);

    const scriptText = $('script').map((_, el) => $(el).html() ?? '').get().join(' ');
    if (!sellerName) {
      const m = scriptText.match(/"sellerName":\s*"([^"]+)"/);
      if (m) sellerName = m[1];
    }

    if (!productName && !price) return null;
    const confidence = [productName, price, sellerName, rating, reviewCount].filter(Boolean).length * 16;
    return { productName, price, sellerName, sellerId: null, rating, reviewCount, soldCount: null, description: null, confidence: Math.min(confidence, 80) };
  } catch {
    return null;
  }
}

// ─── TikTok via Apify proxy ───────────────────────────────────────────────────

async function scrapeTikTokApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogDesc  = $('meta[property="og:description"]').attr('content') ?? null;

    const sellerMatch = url.match(/@([^\/\?]+)/);
    const sellerName = sellerMatch?.[1]?.replace(/_/g, ' ') ?? null;

    let price: number | null = null;
    const priceMatch = (ogTitle ?? '').match(/₱[\s]*([\d,]+\.?\d*)/);
    if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));

    const productName = ogTitle
      ? ogTitle.replace(/₱[\s]*([\d,]+\.?\d*)/, '').replace(/\s+/g, ' ').trim() || ogTitle
      : null;

    if (!productName) return null;
    return { productName, price, sellerName, sellerId: sellerMatch?.[1] ?? null, rating: null, reviewCount: null, soldCount: null, description: ogDesc?.slice(0, 300) ?? null, confidence: 50 };
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
    const ogDesc  = $('meta[property="og:description"]').attr('content') ?? null;

    let price: number | null = null;
    const priceMatch = (ogDesc ?? '').match(/₱\s*([\d,]+\.?\d*)/);
    if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));

    const productName = ogTitle?.replace(/\s*-\s*Facebook.*$/, '').trim() ?? null;
    const listingId = url.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;

    if (!productName && !price) return null;
    return { productName, price, sellerName: null, sellerId: listingId, rating: null, reviewCount: null, soldCount: null, description: ogDesc?.slice(0, 300) ?? null, confidence: 40 };
  } catch {
    return null;
  }
}

// ─── Generic via Apify proxy ──────────────────────────────────────────────────

async function scrapeGenericApify(url: string, client: AxiosInstance): Promise<ApifyResult | null> {
  try {
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    const ogSite  = $('meta[property="og:site_name"]').attr('content') ?? null;

    if (!ogTitle && !ogPrice) return null;
    return { productName: ogTitle, price: ogPrice ? parseFloat(ogPrice) : null, sellerName: ogSite, sellerId: null, rating: null, reviewCount: null, soldCount: null, description: null, confidence: 30 };
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

    console.log(`[Apify] Worker 2 done in ${Date.now() - startMs}ms — confidence:${result?.confidence ?? 0} name:"${result?.productName}"`);
    return result;
  } catch (e: any) {
    console.error(`[Apify] Worker 2 failed: ${e.message}`);
    return null;
  }
}
