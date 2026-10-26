/**
 * IMAP auth resolution.
 *
 * Password accounts (Gmail, generic .xyz hosts) are trivial. OAuth2 accounts
 * (Outlook / personal Microsoft) need a short-lived access token, which we
 * obtain from a long-lived refresh token and cache until just before it
 * expires. A raw accessToken can also be supplied directly (handy for testing
 * before you wire up the refresh flow).
 */

import type { AccountAuth, OAuthCreds } from "./config.js";
import { log } from "./logger.js";

/** What imapflow's `auth` option expects. */
export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class AuthResolver {
  private readonly tokenCache = new Map<string, CachedToken>();

  /** Build the imapflow auth object for an account, refreshing tokens as needed. */
  async resolve(email: string, auth: AccountAuth): Promise<ImapAuth> {
    if (auth.type === "password") {
      return { user: email, pass: auth.pass };
    }
    const accessToken = await this.accessToken(email, auth.staticToken, auth.oauth);
    return { user: email, accessToken };
  }

  /** Get a bearer access token for an OAuth2 account (used by the Graph path). */
  async getAccessToken(email: string, auth: AccountAuth): Promise<string> {
    if (auth.type !== "oauth2") {
      throw new Error(`Account ${email} is not an OAuth2 account.`);
    }
    return this.accessToken(email, auth.staticToken, auth.oauth);
  }

  private async accessToken(
    email: string,
    staticToken: string | undefined,
    oauth: OAuthCreds | undefined,
  ): Promise<string> {
    // No refresh creds — use the supplied token as-is (may expire; testing path).
    if (!oauth) {
      if (staticToken) return staticToken;
      throw new Error(`No OAuth credentials available for ${email}.`);
    }

    const cached = this.tokenCache.get(email);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const { token, expiresIn } = await this.refresh(email, oauth);
    this.tokenCache.set(email, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  }

  private async refresh(email: string, o: OAuthCreds): Promise<{ token: string; expiresIn: number }> {
    const body = new URLSearchParams({
      client_id: o.clientId,
      grant_type: "refresh_token",
      refresh_token: o.refreshToken,
      scope: o.scope,
    });
    if (o.clientSecret) body.set("client_secret", o.clientSecret);

    log.info("oauth.refresh", { account: email, tokenUrl: o.tokenUrl });
    const res = await fetch(o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OAuth token refresh failed for ${email}: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error(`OAuth token refresh for ${email} returned no access_token.`);
    }
    return { token: json.access_token, expiresIn: json.expires_in ?? 3600 };
  }
}
