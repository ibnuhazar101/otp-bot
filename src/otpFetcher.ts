/**
 * On-demand OTP fetching.
 *
 * Instead of holding a persistent IMAP IDLE connection per account, we connect
 * only when the API is asked for a code. This scales to many accounts because
 * idle accounts cost nothing. Two mechanisms keep it from hammering Gmail:
 *
 *   1. Warm-connection cache — after a fetch, the account's connection is kept
 *      open for a short window so rapid polling reuses one TLS session instead
 *      of re-handshaking every request.
 *   2. Single-flight — concurrent requests for the same account+provider
 *      collapse into one IMAP fetch.
 *
 * A request names an account (which mailbox) and a provider (which template to
 * match). Recency filtering is disabled for the prototype (config.recencyMs=0),
 * so the newest matching message wins regardless of age.
 */

import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AppConfig, ResolvedAccount, ResolvedProvider } from "./config.js";
import { AuthResolver } from "./auth.js";
import { GraphClient } from "./graphClient.js";
import { extractOtp } from "./otpParser.js";
import { log } from "./logger.js";

export interface AccountHealth {
  email: string;
  host: string;
  authType: string;
  status: "ok" | "auth_failed" | "error";
  error?: string;
}

export type FetchResult =
  | {
      status: "ok";
      code: string;
      receivedAt: number;
      expiresAt: number | null;
      from: string;
      subject: string;
    }
  | { status: "none" }
  | { status: "unknown_account" }
  | { status: "unknown_provider" }
  | { status: "auth_failed" }
  | { status: "error"; message: string };

interface WarmConnection {
  client: ImapFlow;
  closeTimer: NodeJS.Timeout | null;
}

export class OtpFetcher {
  private readonly accounts = new Map<string, ResolvedAccount>();
  private readonly providers = new Map<string, ResolvedProvider>();
  private readonly warm = new Map<string, WarmConnection>();
  private readonly inFlight = new Map<string, Promise<FetchResult>>();
  private readonly auth = new AuthResolver();
  private readonly graph: GraphClient;

  constructor(private readonly config: AppConfig) {
    for (const account of config.accounts) {
      this.accounts.set(account.email.toLowerCase(), account);
    }
    for (const provider of config.providers) {
      this.providers.set(provider.name.toLowerCase(), provider);
    }
    this.graph = new GraphClient(this.auth, this.config);
  }

  /** Configured account emails, in config order (no secrets). */
  listAccounts(): string[] {
    return this.config.accounts.map((a) => a.email);
  }

  /** Configured providers for the UI dropdown. */
  listProviders(): Array<{ name: string; label: string }> {
    return this.config.providers.map((p) => ({ name: p.name, label: p.label }));
  }

  /** Try to authenticate a single account and report whether it's alive. */
  async checkAccount(email: string): Promise<AccountHealth | null> {
    const account = this.accounts.get(email.toLowerCase());
    if (!account) return null;
    return this.probe(account);
  }

  /** Probe one account's credentials (IMAP or Graph) for the health check. */
  private async probe(account: ResolvedAccount): Promise<AccountHealth> {
    const base = {
      email: account.email,
      host: account.transport === "graph" ? "graph.microsoft.com" : account.imapHost,
      authType: account.auth.type,
    };
    try {
      if (account.transport === "graph") {
        const r = await this.graph.checkAccount(account);
        return { ...base, status: r.status, error: r.error };
      }
      const key = account.email.toLowerCase();
      await this.getClient(account);
      this.scheduleClose(key);
      return { ...base, status: "ok" };
    } catch (err) {
      const status: AccountHealth["status"] = isAuthError(err) ? "auth_failed" : "error";
      return { ...base, status, error: describe(err) };
    }
  }

  /**
   * Try to authenticate every account and report which credentials are alive.
   * Runs with a small concurrency cap so a large fleet doesn't open hundreds of
   * connections at once. Successful connections are left warm (then auto-close).
   */
  async checkHealth(concurrency = 8): Promise<AccountHealth[]> {
    const results: AccountHealth[] = [];
    const queue = [...this.config.accounts];

    const worker = async () => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        results.push(await this.probe(account));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    // Preserve config order in the output.
    const order = new Map(this.config.accounts.map((a, i) => [a.email.toLowerCase(), i]));
    results.sort((a, b) => (order.get(a.email.toLowerCase())! - order.get(b.email.toLowerCase())!));
    return results;
  }

  /** Fetch the latest OTP for an account using a provider's template. */
  fetchOtp(email: string, providerName: string): Promise<FetchResult> {
    const account = this.accounts.get(email.toLowerCase());
    if (!account) return Promise.resolve({ status: "unknown_account" });

    const provider = this.providers.get(providerName.toLowerCase());
    if (!provider) return Promise.resolve({ status: "unknown_provider" });

    const flightKey = `${account.email.toLowerCase()}|${provider.name}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) {
      log.info("otp.fetch_coalesced", { account: account.email, provider: provider.name });
      return existing;
    }

    const promise = this.doFetch(account, provider).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async doFetch(account: ResolvedAccount, provider: ResolvedProvider): Promise<FetchResult> {
    if (account.transport === "graph") {
      return this.graph.fetchOtp(account, provider);
    }

    const key = account.email.toLowerCase();
    // Try once with a possibly-warm connection; if it's stale, retry fresh.
    for (let attempt = 0; attempt < 2; attempt++) {
      let client: ImapFlow;
      try {
        client = await this.getClient(account);
      } catch (err) {
        if (isAuthError(err)) {
          log.error("imap.auth_failed", { account: account.email, error: describe(err) });
          return { status: "auth_failed" };
        }
        log.error("imap.connect_failed", { account: account.email, error: describe(err) });
        return { status: "error", message: "Could not connect to mailbox." };
      }

      try {
        const result = await this.scan(account, provider, client);
        this.scheduleClose(key);
        return result;
      } catch (err) {
        log.warn("imap.fetch_retry", { account: account.email, attempt, error: describe(err) });
        await this.dropConnection(key);
        if (attempt === 1) return { status: "error", message: "Mailbox fetch failed." };
      }
    }
    return { status: "error", message: "Mailbox fetch failed." };
  }

  /** Scan the most recent messages for the newest matching OTP. */
  private async scan(
    account: ResolvedAccount,
    provider: ResolvedProvider,
    client: ImapFlow,
  ): Promise<FetchResult> {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = client.mailbox;
      const total = status && typeof status !== "boolean" ? status.exists : 0;
      if (!total) {
        log.info("otp.request_scan", { account: account.email, provider: provider.name, scanned: 0, result: "none" });
        return { status: "none" };
      }

      // Prefer a server-side SEARCH on the provider's sender (and optionally
      // subject) so we find the mail anywhere in the inbox and skip non-OTP
      // messages before downloading; otherwise fall back to the most recent.
      let range: string;
      if (provider.imapFrom || provider.imapSubjects.length > 0) {
        const query: SearchObject = {};
        if (provider.imapFrom) query.from = provider.imapFrom;
        if (provider.imapSubjects.length === 1) {
          query.subject = provider.imapSubjects[0];
        } else if (provider.imapSubjects.length > 1) {
          // Any one of the subjects may match (e.g. different languages).
          query.or = provider.imapSubjects.map((s) => ({ subject: s }));
        }

        const seqs = await client.search(query);
        if (!seqs || seqs.length === 0) {
          log.info("otp.request_scan", { account: account.email, provider: provider.name, matched: 0, result: "none" });
          return { status: "none" };
        }
        range = seqs.slice(-this.config.fetchLimit).join(",");
      } else {
        const from = Math.max(1, total - this.config.fetchLimit + 1);
        range = `${from}:*`;
      }

      // Recency filtering is disabled for the prototype (recencyMs === 0).
      const applyRecency = this.config.recencyMs > 0;
      const cutoff = applyRecency ? Date.now() - this.config.recencyMs : 0;

      let best: { code: string; receivedAt: number; from: string; subject: string } | null = null;
      let scanned = 0;

      for await (const message of client.fetch(range, {
        source: true,
        envelope: true,
        internalDate: true,
      })) {
        scanned++;
        const receivedAt = messageDate(message);
        if (applyRecency && receivedAt < cutoff) continue; // too old to be a live OTP

        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        const candidate = {
          from: parsed.from?.text ?? message.envelope?.from?.map((a) => a.address).join(", ") ?? "",
          subject: parsed.subject ?? message.envelope?.subject ?? "",
          text: parsed.text ?? "",
        };

        const code = extractOtp(provider, candidate);
        if (code && (!best || receivedAt > best.receivedAt)) {
          best = { code, receivedAt, from: candidate.from, subject: candidate.subject };
        }
      }

      if (!best) {
        log.info("otp.request_scan", { account: account.email, provider: provider.name, scanned, result: "none" });
        return { status: "none" };
      }

      log.info("otp.request_scan", {
        account: account.email,
        provider: provider.name,
        scanned,
        result: "hit",
        code: best.code,
        receivedAt: new Date(best.receivedAt).toISOString(),
      });
      return {
        status: "ok",
        code: best.code,
        receivedAt: best.receivedAt,
        expiresAt: applyRecency ? best.receivedAt + this.config.recencyMs : null,
        from: best.from,
        subject: best.subject,
      };
    } finally {
      lock.release();
    }
  }

  /** Return a connected client for the account, reusing a warm one if present. */
  private async getClient(account: ResolvedAccount): Promise<ImapFlow> {
    const key = account.email.toLowerCase();
    const warm = this.warm.get(key);
    if (warm && warm.client.usable) {
      if (warm.closeTimer) {
        clearTimeout(warm.closeTimer);
        warm.closeTimer = null;
      }
      return warm.client;
    }
    if (warm) await this.dropConnection(key); // present but unusable

    const auth = await this.auth.resolve(account.email, account.auth);
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: true,
      auth,
      logger: false,
    });

    client.on("error", (err: Error) =>
      log.error("imap.error", { account: account.email, error: err.message }),
    );
    client.on("close", () => {
      log.info("imap.closed", { account: account.email });
      this.warm.delete(key);
    });

    log.info("imap.connecting", { account: account.email, host: account.imapHost });
    await client.connect();
    log.info("imap.connected", { account: account.email });

    this.warm.set(key, { client, closeTimer: null });
    return client;
  }

  /** Keep the connection warm for a bit, then log out if unused. */
  private scheduleClose(key: string): void {
    const warm = this.warm.get(key);
    if (!warm) return;
    if (warm.closeTimer) clearTimeout(warm.closeTimer);

    warm.closeTimer = setTimeout(() => {
      if (this.inFlight.has(key)) return; // still busy — leave it
      void this.dropConnection(key);
    }, this.config.warmConnectionMs);
    warm.closeTimer.unref();
  }

  private async dropConnection(key: string): Promise<void> {
    const warm = this.warm.get(key);
    if (!warm) return;
    this.warm.delete(key);
    if (warm.closeTimer) clearTimeout(warm.closeTimer);
    try {
      await warm.client.logout();
    } catch {
      // ignore — best effort
    }
  }

  /** Close all warm connections (used on shutdown). */
  async stop(): Promise<void> {
    await Promise.all([...this.warm.keys()].map((key) => this.dropConnection(key)));
  }
}

function messageDate(message: FetchMessageObject): number {
  const d = message.internalDate ?? message.envelope?.date;
  return d ? new Date(d).getTime() : 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAuthError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { authenticationFailed?: boolean; response?: string; responseText?: string; message?: string };
  if (e.authenticationFailed) return true;
  const text = `${e.response ?? ""} ${e.responseText ?? ""} ${e.message ?? ""}`.toLowerCase();
  return (
    text.includes("invalid credentials") ||
    text.includes("authentication failed") ||
    text.includes("[authenticationfailed]")
  );
}
