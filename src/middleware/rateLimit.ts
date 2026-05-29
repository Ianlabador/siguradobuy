import rateLimit from 'express-rate-limit';

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait before trying again.' },
});

export const checkRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checks — slow down a bit.' },
});

export const reportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Report limit reached for this hour.' },
});

// Strict limiter for admin login — blunts brute-force / credential-stuffing.
// 10 attempts per 15 minutes per IP. Skips counting successful logins.
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

// Support ticket / reply creation limiter — prevents ticket spam.
// 6 actions per 10 minutes per IP.
export const supportRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many support requests — please wait a few minutes.' },
});
