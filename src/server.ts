/**
 * REST API + static one-page UI.
 *
 * GET /            -> the OTP lookup web page (public/index.html)
 * GET /accounts    -> list of configured account emails (for the UI dropdown)
 * GET /providers   -> list of configured providers (for the UI dropdown)
 * GET /otp/:email?provider=<name>
 *                  -> fetches the latest OTP for that mailbox matching the
 *                     provider's template, or 404 if none.
 * GET /health      -> liveness check.
 *
 * No auth yet — this is a prototype meant to run on a trusted network only.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Request, type Response } from "express";
import type { OtpFetcher } from "./otpFetcher.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export function createServer(fetcher: OtpFetcher) {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  app.get("/accounts", (_req: Request, res: Response) => {
    res.json({ accounts: fetcher.listAccounts() });
  });

  app.get("/providers", (_req: Request, res: Response) => {
    res.json({ providers: fetcher.listProviders() });
  });

  app.get("/accounts/health", async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    const accounts = await fetcher.checkHealth();
    const summary = {
      total: accounts.length,
      ok: accounts.filter((a) => a.status === "ok").length,
      auth_failed: accounts.filter((a) => a.status === "auth_failed").length,
      error: accounts.filter((a) => a.status === "error").length,
    };
    log.info("accounts.health", { ...summary, tookMs: Date.now() - startedAt });
    res.json({ summary, accounts });
  });

  app.get("/accounts/:email/health", async (req: Request, res: Response) => {
    const email = req.params.email;
    const startedAt = Date.now();
    const health = await fetcher.checkAccount(email);
    if (!health) {
      res.status(404).json({ error: "Account is not configured.", email });
      return;
    }
    log.info("account.health", { account: email, status: health.status, tookMs: Date.now() - startedAt });
    res.json(health);
  });

  app.get("/otp/:email", async (req: Request, res: Response) => {
    const email = req.params.email;
    const provider = typeof req.query.provider === "string" ? req.query.provider.trim() : "";
    // Placeholder for real requester identity (API key, user id, etc.).
    const requester = req.get("x-requester") ?? req.ip ?? "unknown";
    const startedAt = Date.now();

    if (!provider) {
      res.status(400).json({ error: "Missing required query parameter: provider.", email });
      return;
    }

    const result = await fetcher.fetchOtp(email, provider);
    const tookMs = Date.now() - startedAt;
    const base = { account: email, provider, requester, tookMs };

    switch (result.status) {
      case "ok":
        log.info("otp.request", { ...base, result: "hit" });
        res.json({
          email,
          provider,
          code: result.code,
          from: result.from,
          subject: result.subject,
          receivedAt: new Date(result.receivedAt).toISOString(),
          expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
        });
        return;

      case "none":
        log.info("otp.request", { ...base, result: "not_found" });
        res.status(404).json({ error: "No matching OTP for this account/provider.", email, provider });
        return;

      case "unknown_account":
        log.warn("otp.request", { ...base, result: "unknown_account" });
        res.status(404).json({ error: "Account is not configured.", email });
        return;

      case "unknown_provider":
        log.warn("otp.request", { ...base, result: "unknown_provider" });
        res.status(400).json({ error: "Provider is not configured.", provider });
        return;

      case "auth_failed":
        log.error("otp.request", { ...base, result: "auth_failed" });
        res.status(502).json({ error: "Mailbox authentication failed. Check the app password.", email });
        return;

      case "error":
      default:
        log.error("otp.request", { ...base, result: "error" });
        res.status(502).json({ error: result.status === "error" ? result.message : "Upstream error.", email });
        return;
    }
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
