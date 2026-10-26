/**
 * Microsoft Graph read path (for Outlook / personal Microsoft accounts).
 *
 * Personal Microsoft directories can't issue outlook.office365.com (IMAP)
 * tokens, so we read Outlook mail via the Graph API instead. Same idea as the
 * IMAP path: server-side narrow by the provider's sender, download a few recent
 * matches, then apply the provider's regex client-side to extract the code.
 *
 * The provider templates and OTP extraction are shared with the IMAP path — only
 * the transport differs.
 */

import type { AppConfig, ResolvedAccount, ResolvedProvider } from "./config.js";
import type { AuthResolver } from "./auth.js";
import type { FetchResult } from "./otpFetcher.js";
import { extractOtp } from "./otpParser.js";
import { log } from "./logger.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  body?: { contentType?: string; content?: string };
}

export class GraphClient {
  constructor(
    private readonly auth: AuthResolver,
    private readonly config: AppConfig,
  ) {}

  async fetchOtp(account: ResolvedAccount, provider: ResolvedProvider): Promise<FetchResult> {
    let token: string;
    try {
      token = await this.auth.getAccessToken(account.email, account.auth);
    } catch (err) {
      return authOrError(err, "Could not obtain a Graph access token.");
    }

    // $search narrows server-side by sender. Graph ignores $orderby when
    // $search is present, so we sort the (few) results by date ourselves.
    const url = new URL(`${GRAPH_BASE}/me/messages`);
    if (provider.imapFrom) url.searchParams.set("$search", `"from:${provider.imapFrom}"`);
    url.searchParams.set("$top", String(Math.max(this.config.fetchLimit, 15)));
    url.searchParams.set("$select", "subject,from,receivedDateTime,bodyPreview,body");

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (err) {
      log.error("graph.request_failed", { account: account.email, error: describe(err) });
      return { status: "error", message: "Graph request failed." };
    }

    if (res.status === 401) {
      log.error("graph.auth_failed", { account: account.email });
      return { status: "auth_failed" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error("graph.error", { account: account.email, status: res.status, body: text.slice(0, 300) });
      return { status: "error", message: `Graph error ${res.status}.` };
    }

    const data = (await res.json()) as { value?: GraphMessage[] };
    const messages = (data.value ?? []).slice();
    // Newest first.
    messages.sort((a, b) => msgTime(b) - msgTime(a));

    const applyRecency = this.config.recencyMs > 0;
    const cutoff = applyRecency ? Date.now() - this.config.recencyMs : 0;

    let scanned = 0;
    for (const m of messages) {
      scanned++;
      const receivedAt = msgTime(m);
      if (applyRecency && receivedAt < cutoff) continue;

      const fromName = m.from?.emailAddress?.name ?? "";
      const fromAddr = m.from?.emailAddress?.address ?? "";
      const candidate = {
        from: `${fromName} <${fromAddr}>`.trim(),
        subject: m.subject ?? "",
        text: `${m.bodyPreview ?? ""}\n${stripHtml(m.body?.content ?? "")}`,
      };

      const code = extractOtp(provider, candidate);
      if (code) {
        // messages are newest-first, so the first match is the newest.
        log.info("otp.request_scan", {
          account: account.email,
          provider: provider.name,
          transport: "graph",
          scanned,
          result: "hit",
          code,
        });
        return {
          status: "ok",
          code,
          receivedAt,
          expiresAt: applyRecency ? receivedAt + this.config.recencyMs : null,
          from: candidate.from,
          subject: candidate.subject,
        };
      }
    }

    log.info("otp.request_scan", {
      account: account.email,
      provider: provider.name,
      transport: "graph",
      scanned,
      result: "none",
    });
    return { status: "none" };
  }

  /** Lightweight liveness probe used by the health check. */
  async checkAccount(account: ResolvedAccount): Promise<{ status: "ok" | "auth_failed" | "error"; error?: string }> {
    let token: string;
    try {
      token = await this.auth.getAccessToken(account.email, account.auth);
    } catch (err) {
      const r = authOrError(err, "Token error.");
      return r.status === "auth_failed" ? { status: "auth_failed" } : { status: "error", error: describe(err) };
    }
    try {
      // Probe a Mail.Read-scoped endpoint (not /me, which needs User.Read).
      const res = await fetch(`${GRAPH_BASE}/me/messages?$top=1&$select=id`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.status === 401 || res.status === 403) return { status: "auth_failed" };
      if (!res.ok) return { status: "error", error: `Graph error ${res.status}.` };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", error: describe(err) };
    }
  }
}

function msgTime(m: GraphMessage): number {
  return m.receivedDateTime ? new Date(m.receivedDateTime).getTime() : 0;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** OAuth refresh failures with invalid_grant mean the token is dead → auth_failed. */
function authOrError(err: unknown, fallbackMsg: string): FetchResult {
  const text = describe(err).toLowerCase();
  if (text.includes("invalid_grant") || text.includes("aadsts")) {
    return { status: "auth_failed" };
  }
  return { status: "error", message: fallbackMsg };
}
