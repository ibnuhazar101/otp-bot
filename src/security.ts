/**
 * API-key authentication, rate limiting and a tiny TTL cache for the
 * expensive health endpoints.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { log } from "./logger.js";

export interface ApiKey {
  /** Short, non-reversible label used in logs instead of the key itself. */
  id: string;
  digest: Buffer;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Parse `API_KEYS` (comma separated) / `API_KEY`. Keys shorter than 16 chars are rejected. */
export function loadApiKeys(env: NodeJS.ProcessEnv = process.env): ApiKey[] {
  const raw = [env.API_KEYS, env.API_KEY].filter(Boolean).join(",");
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of keys) {
    if (k.length < 16) {
      throw new Error("API keys must be at least 16 characters. Generate one with: openssl rand -hex 32");
    }
  }
  return [...new Set(keys)].map((k) => {
    const digest = sha256(k);
    return { id: digest.toString("hex").slice(0, 8), digest };
  });
}

function extractToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  return req.get("x-api-key")?.trim() || null;
}

/** Match a presented token against all keys in constant time (digests are fixed length). */
export function matchKey(keys: ApiKey[], token: string): ApiKey | null {
  const presented = sha256(token);
  let found: ApiKey | null = null;
  for (const key of keys) {
    if (timingSafeEqual(key.digest, presented)) found = key;
  }
  return found;
}

declare module "express-serve-static-core" {
  interface Request {
    apiKeyId?: string;
  }
}

export function requireApiKey(keys: ApiKey[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    const key = token ? matchKey(keys, token) : null;
    if (!key) {
      log.warn("auth.rejected", { ip: req.ip, path: req.path });
      res.set("WWW-Authenticate", 'Bearer realm="otp-bot"');
      res.status(401).json({ error: "Missing or invalid API key." });
      return;
    }
    req.apiKeyId = key.id;
    next();
  };
}

const tooMany = (what: string) => ({ error: `Too many ${what}. Slow down and retry shortly.` });

/** Per-IP limiter for requests that FAILED auth (brute-force guard). Mount before auth. */
export const authFailureLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooMany("failed authentication attempts"),
});

/** Generic per-IP ceiling for everything. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooMany("requests"),
});

/** OTP lookups: per API key (falls back to IP). */
export const otpLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.OTP_RATE_LIMIT_PER_MIN ?? 30),
  keyGenerator: (req) => req.apiKeyId ?? req.ip ?? "unknown",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: tooMany("OTP requests"),
});

/** Health checks open IMAP/Graph connections, so they get a much lower budget. */
export const healthLimiter = rateLimit({
  windowMs: 60_000,
  limit: 6,
  keyGenerator: (req) => req.apiKeyId ?? req.ip ?? "unknown",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: tooMany("health checks"),
});

/** TTL cache that also coalesces concurrent calls for the same key. */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.store.set(key, { at: Date.now(), value });
    // Don't cache failures.
    value.catch(() => {
      if (this.store.get(key)?.value === value) this.store.delete(key);
    });
    return value;
  }
}
