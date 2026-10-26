/**
 * Configuration loading.
 *
 * Global settings come from .env. Two JSON files hold the rest:
 *
 *   accounts.json  -> mailbox credentials (secrets — git-ignored)
 *   providers.json -> [{ name, label, senderPattern, otpRegex, imapFrom }]
 *
 * Accounts can be Gmail (app password), any generic IMAP host like a custom
 * .xyz domain (app password + host), or Outlook/personal Microsoft accounts
 * (OAuth2 / XOAUTH2, since Microsoft disabled basic auth for IMAP).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./logger.js";

/** Known domain -> IMAP host, so common providers need no explicit host. */
const DOMAIN_IMAP_HOSTS: Record<string, string> = {
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "live.com": "outlook.office365.com",
  "msn.com": "outlook.office365.com",
};

/** IMAP hosts that require OAuth2 (Microsoft killed basic auth for these). */
const OAUTH_HOSTS = new Set(["outlook.office365.com"]);

// Personal Microsoft directories can't issue outlook.office365.com (IMAP)
// tokens, so Outlook accounts read mail via the Microsoft Graph API instead.
const DEFAULT_GRAPH_SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";
const DEFAULT_IMAP_OAUTH_SCOPE = "https://outlook.office365.com/IMAP.AccessAsUser.All offline_access";

export interface OAuthCreds {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  tenant: string;
  scope: string;
  tokenUrl: string;
}

export type AccountAuth =
  | { type: "password"; pass: string }
  | { type: "oauth2"; staticToken?: string; oauth?: OAuthCreds };

export interface ResolvedAccount {
  email: string;
  imapHost: string;
  imapPort: number;
  auth: AccountAuth;
  /** How we read this mailbox: IMAP (Gmail/.xyz) or Microsoft Graph (Outlook). */
  transport: "imap" | "graph";
}

export interface ProviderConfig {
  name: string;
  label?: string;
  senderPattern: string;
  otpRegex: string;
  imapFrom?: string;
  /** Optional server-side subject filter. Array = OR (any one may match). */
  imapSubject?: string | string[];
}

export interface ResolvedProvider {
  name: string;
  label: string;
  senderPattern: RegExp;
  otpRegex: RegExp;
  imapFrom: string | null;
  /** Normalised subject filters; empty = no subject filtering. Multiple = OR. */
  imapSubjects: string[];
}

export interface AppConfig {
  serverHost: string;
  serverPort: number;
  recencyMs: number;
  fetchLimit: number;
  warmConnectionMs: number;
  accounts: ResolvedAccount[];
  providers: ResolvedProvider[];
}

function requireEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function readJsonArray(path: string, what: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${what} file at ${path}. (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${what} file ${path} must contain a JSON array.`);
  }
  return parsed;
}

function resolveAccount(entry: unknown, i: number): ResolvedAccount {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`Account at index ${i} is not an object.`);
  }
  const acc = entry as Record<string, unknown>;
  if (typeof acc.email !== "string" || !acc.email.includes("@")) {
    throw new Error(`Account at index ${i} is missing a valid "email".`);
  }
  const email = acc.email.trim();
  const domain = email.split("@")[1].toLowerCase();

  const imapHost =
    (typeof acc.imapHost === "string" && acc.imapHost.trim()) ||
    DOMAIN_IMAP_HOSTS[domain] ||
    (process.env.IMAP_HOST && process.env.IMAP_HOST.trim());
  if (!imapHost) {
    throw new Error(
      `Account "${email}": unknown mail host. Add an "imapHost" field (e.g. "mail.${domain}").`,
    );
  }
  const imapPort = typeof acc.imapPort === "number" ? acc.imapPort : requireEnvInt("IMAP_PORT", 993);

  // Default auth type: OAuth2 for hosts that require it, password otherwise.
  const authType =
    (typeof acc.authType === "string" && acc.authType.toLowerCase()) ||
    (OAUTH_HOSTS.has(imapHost) ? "oauth2" : "password");

  // Outlook OAuth reads via Microsoft Graph (IMAP-over-OAuth isn't available for
  // personal accounts); everything else uses IMAP. Overridable per account.
  const transport: "imap" | "graph" =
    typeof acc.transport === "string" && (acc.transport === "graph" || acc.transport === "imap")
      ? acc.transport
      : OAUTH_HOSTS.has(imapHost)
        ? "graph"
        : "imap";

  let auth: AccountAuth;
  if (authType === "oauth2") {
    const staticToken = typeof acc.accessToken === "string" ? acc.accessToken : undefined;
    const rawOauth = acc.oauth as Record<string, unknown> | undefined;
    let oauth: OAuthCreds | undefined;
    if (rawOauth && typeof rawOauth === "object") {
      if (typeof rawOauth.clientId !== "string" || typeof rawOauth.refreshToken !== "string") {
        throw new Error(`Account "${email}": oauth requires "clientId" and "refreshToken".`);
      }
      const tenant = typeof rawOauth.tenant === "string" ? rawOauth.tenant : "consumers";
      const defaultScope = transport === "graph" ? DEFAULT_GRAPH_SCOPE : DEFAULT_IMAP_OAUTH_SCOPE;
      oauth = {
        clientId: rawOauth.clientId,
        clientSecret: typeof rawOauth.clientSecret === "string" ? rawOauth.clientSecret : undefined,
        refreshToken: rawOauth.refreshToken,
        tenant,
        scope: typeof rawOauth.scope === "string" ? rawOauth.scope : defaultScope,
        tokenUrl:
          typeof rawOauth.tokenUrl === "string"
            ? rawOauth.tokenUrl
            : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      };
    }
    if (!staticToken && !oauth) {
      throw new Error(
        `Account "${email}" uses OAuth2 but has neither "accessToken" nor an "oauth" block. ` +
          `See accounts.example.json for the Outlook setup.`,
      );
    }
    auth = { type: "oauth2", staticToken, oauth };
  } else {
    if (typeof acc.appPassword !== "string" || acc.appPassword.trim() === "") {
      throw new Error(`Account "${email}" is missing a valid "appPassword".`);
    }
    auth = { type: "password", pass: acc.appPassword };
  }

  return { email, imapHost, imapPort, auth, transport };
}

function loadAccounts(path: string): ResolvedAccount[] {
  const entries = readJsonArray(path, "accounts");
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const account = resolveAccount(entry, i);
    const key = account.email.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate account email in config: ${account.email}`);
    seen.add(key);
    return account;
  });
}

function compileRegex(pattern: string, context: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`Invalid regex for ${context}: ${(err as Error).message}`);
  }
}

function loadProviders(path: string): ResolvedProvider[] {
  const entries = readJsonArray(path, "providers");
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Provider at index ${i} is not an object.`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.name !== "string" || p.name.trim() === "") {
      throw new Error(`Provider at index ${i} is missing a valid "name".`);
    }
    if (typeof p.senderPattern !== "string" || p.senderPattern.trim() === "") {
      throw new Error(`Provider "${p.name}" is missing a valid "senderPattern".`);
    }
    if (typeof p.otpRegex !== "string" || p.otpRegex.trim() === "") {
      throw new Error(`Provider "${p.name}" is missing a valid "otpRegex".`);
    }
    const name = p.name.trim().toLowerCase();
    if (seen.has(name)) throw new Error(`Duplicate provider name in config: ${p.name}`);
    seen.add(name);

    const rawSubjects = Array.isArray(p.imapSubject)
      ? p.imapSubject
      : typeof p.imapSubject === "string"
        ? [p.imapSubject]
        : [];
    const imapSubjects = rawSubjects
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim());

    return {
      name,
      label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : name,
      senderPattern: compileRegex(p.senderPattern, `provider ${name} senderPattern`),
      otpRegex: compileRegex(p.otpRegex, `provider ${name} otpRegex`),
      imapFrom: typeof p.imapFrom === "string" && p.imapFrom.trim() ? p.imapFrom.trim() : null,
      imapSubjects,
    };
  });
}

export function loadConfig(): AppConfig {
  const accountsPath = resolve(process.env.ACCOUNTS_FILE ?? "accounts.json");
  const providersPath = resolve(process.env.PROVIDERS_FILE ?? "providers.json");

  const accounts = loadAccounts(accountsPath);
  if (accounts.length === 0) throw new Error(`No accounts configured in ${accountsPath}.`);

  const providers = loadProviders(providersPath);
  if (providers.length === 0) throw new Error(`No providers configured in ${providersPath}.`);

  const config: AppConfig = {
    serverHost: process.env.HOST ?? "0.0.0.0",
    serverPort: requireEnvInt("PORT", 3000),
    // Prototype: recency disabled (0) so old test emails still resolve.
    recencyMs: requireEnvInt("OTP_RECENCY_SECONDS", 0) * 1000,
    fetchLimit: requireEnvInt("FETCH_LIMIT", 10),
    warmConnectionMs: requireEnvInt("WARM_CONNECTION_SECONDS", 30) * 1000,
    accounts,
    providers,
  };

  log.info("config.loaded", {
    accountsFile: accountsPath,
    providersFile: providersPath,
    accountCount: accounts.length,
    authTypes: accounts.map((a) => a.auth.type).join(","),
    providers: providers.map((p) => p.name).join(","),
    recencySeconds: config.recencyMs / 1000,
  });

  return config;
}
