import axios from 'axios';
import * as cheerio from 'cheerio';
import { runApifyFallback } from './apify';

export type Platform = 'shopee' | 'lazada' | 'tiktok' | 'facebook' | 'other';

export interface DataSources {
  price:       boolean;
  seller:      boolean;
  reviews:     boolean;
  rating:      boolean;
  description: boolean;
  soldCount:   boolean;
}

export interface ExtractedProduct {
  platform:         Platform;
  productName:      string | null;
  price:            number | null;
  sellerName:       string | null;
  sellerId:         string | null;
  sellerUrl:        string | null;
  rating:           number | null;
  reviewCount:      number | null;
  soldCount:        number | null;
  description:      string | null;
  category:         string | null;
  sellerAge:        string | null;
  rawUrl:           string;
  resolvedUrl:      string;
  partial:          boolean;
  extractMethod:    string;
  confidence:       number;    // 0–100
  workerUsed:       number;    // 1 = direct, 2 = apify
  dataSources:      DataSources;
  needsDeeperCheck: boolean;   // true if W1 confidence < 60 and forceDeepScan not requested
}

// ─── Confidence ───────────────────────────────────────────────────────────────
// Weighted by what we actually got:
//   title=20, price=20, seller=20, rating=15, reviews=15, description=10 = 100 max
// Platform-specific penalties applied if a platform SHOULD have certain data.
// e.g. Facebook doesn't expose seller info → don't penalise for it being missing.

export function calculateConfidence(product: Partial<ExtractedProduct>): number {
  let score = 0;
  if (product.productName)    score += 20;
  if (product.price)          score += 20;
  if (product.sellerName)     score += 20;
  if (product.rating    != null) score += 15;
  if (product.reviewCount != null) score += 15;
  if (product.description)    score += 10;

  // Platforms where seller info is structurally unavailable: don't double-penalise
  // by expecting it. Cap confidence at 80 for Facebook/TikTok since we can't get seller data.
  const platform = (product as any).platform as string | undefined;
  if ((platform === 'facebook' || platform === 'tiktok') && score > 80) score = 80;

  return score;
}

// ─── Apify result cache (24-hour TTL, in-memory) ──────────────────────────────

interface CacheEntry { result: import('./apify').ApifyResult; expiresAt: number; }
const apifyCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedApify(url: string): import('./apify').ApifyResult | null {
  const entry = apifyCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { apifyCache.delete(url); return null; }
  console.log(`[Apify] Cache hit for ${url.slice(0, 60)}...`);
  return entry.result;
}

function setCachedApify(url: string, result: import('./apify').ApifyResult): void {
  apifyCache.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

function buildDataSources(product: Partial<ExtractedProduct>): DataSources {
  return {
    price:       !!product.price,
    seller:      !!product.sellerName,
    reviews:     product.reviewCount != null,
    rating:      product.rating      != null,
    description: !!product.description,
    soldCount:   product.soldCount   != null,
  };
}

// ─── URL resolution ───────────────────────────────────────────────────────────

async function resolveUrl(url: string): Promise<string> {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5, timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' },
      validateStatus: () => true,
    });
    return res.request?.res?.responseUrl ?? res.config?.url ?? url;
  } catch { return url; }
}

// ─── Platform detection ───────────────────────────────────────────────────────

export function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (u.includes('shopee.ph') || u.includes('shope.ee'))                         return 'shopee';
  if (u.includes('lazada.com.ph') || u.includes('lzd.co') || u.includes('i.lazada.com.ph')) return 'lazada';
  if (u.includes('tiktok.com') || u.includes('shop.tiktok') || u.includes('vt.tiktok.com')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.com') || u.includes('fb.watch') || u.includes('fb.me')) return 'facebook';
  return 'other';
}

// ─── Worker 1: Direct scrapers ────────────────────────────────────────────────

type Scraped = Partial<ExtractedProduct> & { extractMethod: string };

async function scrapeShopee(url: string): Promise<Scraped> {
  const apiMatch = url.match(/i\.(\d+)\.(\d+)/);
  if (apiMatch) {
    try {
      const [, shopId, itemId] = apiMatch;
      const res = await axios.get(
        `https://shopee.ph/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', 'Referer': 'https://shopee.ph/', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 8000 },
      );
      const d = res.data?.data;
      if (d?.name) {
        const ratingData = d.item_rating;
        // Shopee API: price is in units of 100000 (divide to get PHP)
        const pricePhp = d.price != null ? d.price / 100000 : null;
        // price_min/price_max give range for variations
        const priceMin = d.price_min != null ? d.price_min / 100000 : null;
        const finalPrice = pricePhp ?? priceMin;
        console.log(`[W1] Shopee API: "${d.name}" ₱${finalPrice} seller:${d.shop_name} sold:${d.historical_sold ?? d.sold}`);
        return {
          productName:  d.name,
          price:        finalPrice,
          sellerName:   d.shop_name ?? null,
          sellerId:     shopId,
          rating:       ratingData?.rating_star ?? null,
          reviewCount:  ratingData?.rating_count?.[0] ?? null,
          soldCount:    d.historical_sold ?? d.sold ?? null,
          description:  (d.description ?? '').slice(0, 600) || null,
          category:     d.categories?.[d.categories.length - 1]?.display_name ?? null,
          extractMethod: 'api',
        };
      }
    } catch (e: any) { console.log(`[W1] Shopee API failed: ${e.message}`); }
  }

  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, timeout: 8000 });
    const $ = cheerio.load(res.data);
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    let productName: string | null = ogTitle;
    let price: number | null = ogPrice ? parseFloat(ogPrice) : null;
    let rating: number | null = null; let reviewCount: number | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try { const j = JSON.parse($(el).html() ?? ''); if (j.name) { productName = j.name; price = j.offers?.price ?? price; rating = j.aggregateRating?.ratingValue ?? rating; reviewCount = j.aggregateRating?.reviewCount ?? reviewCount; } } catch { /* skip */ }
    });
    const sellerMatch = url.match(/shopee\.ph\/([^\/\?]+)\//);
    return { productName, price, sellerName: sellerMatch?.[1]?.replace(/-/g, ' ') ?? null, rating, reviewCount, extractMethod: productName !== ogTitle ? 'html_jsonld' : 'og' };
  } catch {
    const sellerMatch = url.match(/shopee\.ph\/([^\/\?]+)\//);
    return { sellerName: sellerMatch?.[1]?.replace(/-/g, ' ') ?? null, extractMethod: 'url_only' };
  }
}

async function scrapeLazada(url: string): Promise<Scraped> {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, timeout: 8000 });
    const $ = cheerio.load(res.data);
    let productName: string | null = null; let price: number | null = null; let sellerName: string | null = null; let rating: number | null = null; let reviewCount: number | null = null; let soldCount: number | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '');
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item['@type'] === 'Product' || item.name) {
            productName = item.name ?? productName;
            const rp = item.offers?.price ?? item.price;
            if (rp) price = typeof rp === 'string' ? parseFloat(rp.replace(/,/g, '')) : rp;
            rating = item.aggregateRating?.ratingValue ?? rating;
            reviewCount = item.aggregateRating?.reviewCount ?? item.aggregateRating?.ratingCount ?? reviewCount;
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
    if (!sellerName) { const m = scriptText.match(/"sellerName":\s*"([^"]+)"/); if (m) sellerName = m[1]; }
    const sm = scriptText.match(/"sold":\s*(\d+)/); if (sm) soldCount = parseInt(sm[1]);
    const rm = scriptText.match(/"rating":\s*"?(\d+\.?\d*)"?/); if (!rating && rm) rating = parseFloat(rm[1]);
    const rcm = scriptText.match(/"reviewCount":\s*(\d+)/); if (!reviewCount && rcm) reviewCount = parseInt(rcm[1]);
    console.log(`[W1] Lazada: "${productName}" ₱${price} seller:${sellerName}`);
    return { productName, price, sellerName, rating, reviewCount, soldCount, extractMethod: productName ? 'html_jsonld' : 'og' };
  } catch { return { extractMethod: 'url_only' }; }
}

async function scrapeTikTok(url: string): Promise<Scraped> {
  let resolvedUrl = url;
  if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) resolvedUrl = await resolveUrl(url);

  const sellerMatch = resolvedUrl.match(/@([^\/\?]+)/);
  const sellerId    = sellerMatch?.[1] ?? null;
  const sellerName  = sellerId?.replace(/[_\.]/g, ' ') ?? null;

  try {
    const res = await axios.get(resolvedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      timeout: 8000,
    });
    const $ = cheerio.load(res.data);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogDesc  = $('meta[property="og:description"]').attr('content') ?? null;

    // Extract price from title or description (TikTok Shop often embeds it)
    let price: number | null = null;
    const fullText = [ogTitle, ogDesc].filter(Boolean).join(' ');
    const pm = fullText.match(/₱\s*([\d,]+(?:\.\d{1,2})?)/);
    if (pm) price = parseFloat(pm[1].replace(/,/g, ''));

    // Clean product name — remove price and platform suffix
    let productName: string | null = ogTitle;
    if (productName) {
      productName = productName
        .replace(/₱\s*[\d,]+(?:\.\d{1,2})?/g, '')
        .replace(/\s*-?\s*TikTok.*$/i, '')
        .replace(/\s+/g, ' ').trim()
        || ogTitle;
    }

    // JSON-LD for TikTok Shop product pages
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const j = JSON.parse($(el).html() ?? '');
        if (j.name && !productName) productName = j.name;
        const p = j.offers?.price ?? j.price;
        if (p && !price) price = typeof p === 'string' ? parseFloat(p.replace(/,/g, '')) : p;
      } catch { /* skip */ }
    });

    const method = productName ? (price ? 'og+price' : 'og') : 'url_only';
    console.log(`[W1] TikTok: "${productName}" ₱${price} seller:${sellerName}`);
    return { productName, price, sellerName, sellerId, description: ogDesc?.slice(0, 300) ?? null, extractMethod: method };
  } catch {
    return { sellerName, sellerId, extractMethod: 'url_only' };
  }
}

async function scrapeFacebook(url: string): Promise<Scraped> {
  const listingId = url.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
    });
    const $ = cheerio.load(res.data);

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
    const ogDesc  = $('meta[property="og:description"]').attr('content') ?? null;
    const ogType  = $('meta[property="og:type"]').attr('content') ?? null;

    // Clean product title: remove " - Facebook Marketplace" suffix
    const productName = ogTitle
      ? ogTitle.replace(/\s*[-|]\s*Facebook.*$/i, '').trim() || ogTitle
      : null;

    // Extract price from description (₱ or PHP or P followed by digits)
    let price: number | null = null;
    const fullText = [ogDesc, ogTitle].filter(Boolean).join(' ');
    const pricePatterns = [
      /₱\s*([\d,]+(?:\.\d{1,2})?)/,           // ₱1,234
      /PHP\s*([\d,]+(?:\.\d{1,2})?)/i,          // PHP 1234
      /\bP\s*([\d,]+(?:\.\d{1,2})?)\b/,         // P1234
      /([\d,]+(?:\.\d{1,2})?)\s*pesos?/i,       // 1234 pesos
    ];
    for (const pat of pricePatterns) {
      const m = fullText.match(pat);
      if (m) { price = parseFloat(m[1].replace(/,/g, '')); break; }
    }

    // Extract condition/details from description
    const desc = ogDesc?.slice(0, 400) ?? null;

    // JSON-LD may contain product info on some FB Marketplace pages
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const j = JSON.parse($(el).html() ?? '');
        if (j['@type'] === 'Product' || j.name) {
          const p = j.offers?.price ?? j.price;
          if (p && !price) price = typeof p === 'string' ? parseFloat(p.replace(/,/g, '')) : p;
        }
      } catch { /* skip */ }
    });

    const method = productName ? (price ? 'og+price' : 'og') : 'url_only';
    console.log(`[W1] Facebook: "${productName}" ₱${price} listing:${listingId}`);
    return { productName, price, sellerId: listingId, description: desc, extractMethod: method };
  } catch {
    return { sellerId: listingId, extractMethod: 'url_only' };
  }
}

async function scrapeGeneric(url: string): Promise<Scraped> {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, timeout: 8000 });
    const $ = cheerio.load(res.data);
    let productName: string | null = null; let price: number | null = null; let sellerName: string | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try { const j = JSON.parse($(el).html() ?? ''); if (j['@type'] === 'Product') { productName = j.name ?? productName; price = j.offers?.price ?? null; sellerName = j.seller?.name ?? j.brand?.name ?? null; } } catch { /* skip */ }
    });
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null;
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
    return { productName: productName ?? ogTitle, price: price ?? (ogPrice ? parseFloat(ogPrice) : null), sellerName: sellerName ?? $('meta[property="og:site_name"]').attr('content') ?? null, extractMethod: 'og' };
  } catch { return { extractMethod: 'url_only' }; }
}

// ─── Seller ID from URL ───────────────────────────────────────────────────────

function extractSellerIdFromUrl(url: string, platform: Platform): string | null {
  try {
    const parsed = new URL(url);
    if (platform === 'shopee')   { const m = url.match(/i\.(\d+)\.(\d+)/); if (m) return m[1]; return parsed.pathname.match(/^\/([^\/]+)\//)?.[1] ?? null; }
    if (platform === 'lazada')   return parsed.pathname.match(/\/shop\/([^\/]+)/)?.[1] ?? null;
    if (platform === 'tiktok')   return parsed.pathname.match(/@([^\/]+)/)?.[1] ?? null;
    if (platform === 'facebook') return parsed.pathname.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;
  } catch { return null; }
  return null;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function extractFromUrl(url: string, isPaidPlan = false, forceDeepScan = false): Promise<ExtractedProduct> {
  const rawUrl = url;

  // Resolve short URLs
  let resolvedUrl = url;
  if (url.includes('shope.ee') || url.includes('lzd.co') || url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) {
    resolvedUrl = await resolveUrl(url);
    console.log(`[Extractor] Resolved → ${resolvedUrl}`);
  }

  const platform = (() => {
    const rp = detectPlatform(resolvedUrl);
    return rp !== 'other' ? rp : detectPlatform(url);
  })();

  // ── Worker 1: Direct scrape ───────────────────────────────────────────────
  let scraped: Scraped = { extractMethod: 'url_only' };

  if (platform === 'shopee')        scraped = await scrapeShopee(resolvedUrl);
  else if (platform === 'lazada')   scraped = await scrapeLazada(resolvedUrl);
  else if (platform === 'tiktok')   scraped = await scrapeTikTok(resolvedUrl);
  else if (platform === 'facebook') scraped = await scrapeFacebook(resolvedUrl);
  else                               scraped = await scrapeGeneric(resolvedUrl);

  let confidence  = calculateConfidence(scraped);
  let workerUsed  = 1;

  console.log(`[W1] done — platform:${platform} method:${scraped.extractMethod} confidence:${confidence}% name:"${scraped.productName}"`);

  // ── Decide whether W2 is needed ───────────────────────────────────────────
  const needsFallback = confidence < 60 || scraped.extractMethod === 'url_only';

  if (needsFallback && !forceDeepScan) {
    // Return W1 result — mobile will show "Generate Again with Deeper Check" button
    console.log(`[Extractor] Confidence ${confidence}% < 60, forceDeepScan=false → returning needsDeeperCheck`);
    const sellerId = scraped.sellerId ?? extractSellerIdFromUrl(resolvedUrl, platform);
    const hasData  = !!(scraped.productName || scraped.price || scraped.sellerName);
    return _buildProduct(platform, scraped, sellerId, rawUrl, resolvedUrl, confidence, 1, hasData, true);
  }

  // ── Worker 2: Apify (forceDeepScan=true or always-on future flag) ─────────
  if (needsFallback && forceDeepScan) {
    if (!process.env.APIFY_API_TOKEN) {
      console.log('[Extractor] forceDeepScan requested but APIFY_API_TOKEN not set');
    } else {
      // Check cache first
      const cached = getCachedApify(resolvedUrl);
      const apify  = cached ?? await runApifyFallback(url, resolvedUrl, platform);

      if (apify && !cached) setCachedApify(resolvedUrl, apify);

      if (apify) {
        const merged: Scraped = {
          productName:   scraped.productName  ?? apify.productName,
          price:         scraped.price        ?? apify.price,
          sellerName:    scraped.sellerName   ?? apify.sellerName,
          sellerId:      scraped.sellerId     ?? apify.sellerId,
          rating:        scraped.rating       ?? apify.rating,
          reviewCount:   scraped.reviewCount  ?? apify.reviewCount,
          soldCount:     scraped.soldCount    ?? apify.soldCount,
          description:   scraped.description  ?? apify.description,
          extractMethod: scraped.extractMethod === 'url_only' ? 'apify' : scraped.extractMethod + '+apify',
        };
        const mergedConf = calculateConfidence(merged);
        if (mergedConf >= confidence) {
          scraped    = merged;
          confidence = mergedConf;
          workerUsed = 2;
          console.log(`[W2] Apify improved confidence to ${confidence}%`);
        }
      }
    }
  }

  const hasData = !!(scraped.productName || scraped.price || scraped.sellerName);
  const sellerId = scraped.sellerId ?? extractSellerIdFromUrl(resolvedUrl, platform);

  return _buildProduct(platform, scraped, sellerId, rawUrl, resolvedUrl, confidence, workerUsed, hasData, false);
}

function _buildProduct(
  platform:    Platform,
  scraped:     Scraped,
  sellerId:    string | null,
  rawUrl:      string,
  resolvedUrl: string,
  confidence:  number,
  workerUsed:  number,
  hasData:     boolean,
  needsDeeperCheck: boolean,
): ExtractedProduct {
  const partial = !hasData || scraped.extractMethod === 'url_only';

  const product: ExtractedProduct = {
    platform,
    productName:      scraped.productName  ?? null,
    price:            scraped.price        ?? null,
    sellerName:       scraped.sellerName   ?? null,
    sellerId,
    sellerUrl:        null,
    rating:           scraped.rating       ?? null,
    reviewCount:      scraped.reviewCount  ?? null,
    soldCount:        scraped.soldCount    ?? null,
    description:      scraped.description  ?? null,
    category:         (scraped as any).category ?? null,
    sellerAge:        null,
    rawUrl,
    resolvedUrl,
    partial,
    extractMethod:    scraped.extractMethod,
    confidence,
    workerUsed,
    dataSources:      buildDataSources(scraped),
    needsDeeperCheck,
  };

  console.log(
    `[Extractor] Final — worker:${workerUsed} confidence:${confidence}%`,
    `partial:${partial} deeperCheck:${needsDeeperCheck} name:"${product.productName}"`,
    `price:${product.price} seller:"${product.sellerName}"`,
    `rating:${product.rating} reviews:${product.reviewCount} sold:${product.soldCount}`,
  );

  return product;
}

export function normalizeProductKeyword(name: string): string {
  return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
}
