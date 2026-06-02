/**
 * ai.ts (routes) — public AI status. Mounted at /api/ai.
 * Returns only safe config info — NEVER the API key.
 */

import { Router, Request, Response } from 'express';
import { getAIStatus } from '../services/ai';

const router = Router();

// GET /api/ai/status
router.get('/status', (_req: Request, res: Response): void => {
  res.json(getAIStatus());
});

export default router;
