import { db } from './client';

const SCAM_KEYWORDS = [
  // Urgency
  { keyword: 'limited offer', weight: 8, language: 'en', category: 'urgency' },
  { keyword: 'today only', weight: 9, language: 'en', category: 'urgency' },
  { keyword: 'last chance', weight: 8, language: 'en', category: 'urgency' },
  { keyword: 'hurry', weight: 6, language: 'en', category: 'urgency' },
  { keyword: 'act now', weight: 7, language: 'en', category: 'urgency' },
  { keyword: 'bilisan', weight: 8, language: 'fil', category: 'urgency' },
  { keyword: 'mabilis lang', weight: 7, language: 'fil', category: 'urgency' },
  { keyword: 'ngayon na', weight: 7, language: 'fil', category: 'urgency' },
  { keyword: 'limited stocks', weight: 7, language: 'en', category: 'urgency' },
  { keyword: 'flash sale', weight: 4, language: 'en', category: 'urgency' },

  // Fake discounts
  { keyword: '90% off', weight: 12, language: 'en', category: 'fake_discount' },
  { keyword: '95% off', weight: 15, language: 'en', category: 'fake_discount' },
  { keyword: '80% off', weight: 10, language: 'en', category: 'fake_discount' },
  { keyword: 'original price', weight: 5, language: 'en', category: 'fake_discount' },
  { keyword: 'factory price', weight: 8, language: 'en', category: 'fake_discount' },
  { keyword: 'wholesale price', weight: 6, language: 'en', category: 'fake_discount' },
  { keyword: 'below cost', weight: 10, language: 'en', category: 'fake_discount' },
  { keyword: 'presyo ng pabrika', weight: 8, language: 'fil', category: 'fake_discount' },
  { keyword: 'tipid na tipid', weight: 6, language: 'fil', category: 'fake_discount' },

  // Pressure tactics
  { keyword: 'pm for price', weight: 9, language: 'en', category: 'pressure' },
  { keyword: 'pm me', weight: 7, language: 'en', category: 'pressure' },
  { keyword: 'message for details', weight: 6, language: 'en', category: 'pressure' },
  { keyword: 'no return no exchange', weight: 8, language: 'en', category: 'pressure' },
  { keyword: 'as is', weight: 7, language: 'en', category: 'pressure' },
  { keyword: 'sold as is', weight: 8, language: 'en', category: 'pressure' },
  { keyword: 'magmessage kayo', weight: 6, language: 'fil', category: 'pressure' },
  { keyword: 'i-pm lang', weight: 7, language: 'fil', category: 'pressure' },
  { keyword: 'no meet up', weight: 5, language: 'en', category: 'pressure' },

  // Suspicious payment
  { keyword: 'gcash first', weight: 15, language: 'en', category: 'payment' },
  { keyword: 'gcash only', weight: 10, language: 'en', category: 'payment' },
  { keyword: 'bayad muna', weight: 12, language: 'fil', category: 'payment' },
  { keyword: 'send money first', weight: 15, language: 'en', category: 'payment' },
  { keyword: 'payment first', weight: 12, language: 'en', category: 'payment' },
  { keyword: 'downpayment', weight: 8, language: 'en', category: 'payment' },
  { keyword: 'dp first', weight: 10, language: 'en', category: 'payment' },
  { keyword: 'palakihin mo', weight: 9, language: 'fil', category: 'payment' },
  { keyword: 'i-send mo muna', weight: 12, language: 'fil', category: 'payment' },
  { keyword: 'pera muna', weight: 12, language: 'fil', category: 'payment' },

  // Impersonation signals
  { keyword: 'official distributor', weight: 7, language: 'en', category: 'impersonation' },
  { keyword: 'authorized seller', weight: 5, language: 'en', category: 'impersonation' },
  { keyword: 'direct from brand', weight: 7, language: 'en', category: 'impersonation' },
  { keyword: 'i am the supplier', weight: 9, language: 'en', category: 'impersonation' },
  { keyword: 'legit seller', weight: 4, language: 'en', category: 'impersonation' },
  { keyword: 'legit shop', weight: 4, language: 'en', category: 'impersonation' },
  { keyword: 'panigurado legit', weight: 5, language: 'fil', category: 'impersonation' },

  // Suspicious
  { keyword: 'no box', weight: 6, language: 'en', category: 'suspicious' },
  { keyword: 'no receipt', weight: 7, language: 'en', category: 'suspicious' },
  { keyword: 'no warranty', weight: 6, language: 'en', category: 'suspicious' },
  { keyword: 'pre-order', weight: 3, language: 'en', category: 'suspicious' },
  { keyword: 'international version', weight: 5, language: 'en', category: 'suspicious' },
  { keyword: 'first come first served', weight: 5, language: 'en', category: 'suspicious' },
];

const PRICE_BASELINES = [
  { product_keyword: 'iphone 16 pro', platform: null, avg_price: 64000, min_price: 58000, max_price: 75000, sample_count: 100 },
  { product_keyword: 'iphone 15', platform: null, avg_price: 48000, min_price: 42000, max_price: 58000, sample_count: 150 },
  { product_keyword: 'samsung galaxy s24', platform: null, avg_price: 42000, min_price: 38000, max_price: 52000, sample_count: 80 },
  { product_keyword: 'airpods pro', platform: null, avg_price: 14000, min_price: 12000, max_price: 18000, sample_count: 200 },
  { product_keyword: 'macbook air', platform: null, avg_price: 72000, min_price: 65000, max_price: 85000, sample_count: 50 },
  { product_keyword: 'playstation 5', platform: null, avg_price: 28000, min_price: 25000, max_price: 35000, sample_count: 70 },
  { product_keyword: 'nike shoes', platform: null, avg_price: 4500, min_price: 2500, max_price: 12000, sample_count: 500 },
  { product_keyword: 'ipad', platform: null, avg_price: 30000, min_price: 22000, max_price: 55000, sample_count: 120 },
  { product_keyword: 'laptop', platform: null, avg_price: 35000, min_price: 18000, max_price: 80000, sample_count: 300 },
  { product_keyword: 'perfume', platform: null, avg_price: 2500, min_price: 800, max_price: 12000, sample_count: 400 },
];

async function seed() {
  console.log('Seeding scam keywords...');
  const { error: kwError } = await db
    .from('scam_keywords')
    .upsert(SCAM_KEYWORDS, { onConflict: 'keyword' });

  if (kwError) {
    console.error('Keyword seed error:', kwError.message);
  } else {
    console.log(`Seeded ${SCAM_KEYWORDS.length} scam keywords`);
  }

  console.log('Seeding price baselines...');
  const { error: priceError } = await db
    .from('price_baselines')
    .upsert(PRICE_BASELINES, { onConflict: 'product_keyword,platform' });

  if (priceError) {
    console.error('Price baseline seed error:', priceError.message);
  } else {
    console.log(`Seeded ${PRICE_BASELINES.length} price baselines`);
  }

  console.log('Seed complete.');
}

seed().catch(console.error);
