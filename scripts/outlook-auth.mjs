#!/usr/bin/env node
/**
 * Outlook / personal Microsoft OAuth helper.
 *
 * Runs the authorization-code flow (with PKCE, public client — no secret) to
 * obtain a REFRESH TOKEN for one @outlook.com account, then prints the
 * accounts.json snippet to paste in. The running service uses that refresh
 * token to mint IMAP access tokens automatically.
 *
 * Prereqs (one-time, in the Azure portal — see README "Outlook setup"):
 *   1. Register an app. Supported account types: personal Microsoft accounts.
 *   2. Authentication → add platform "Mobile and desktop applications" with
 *      redirect URI  http://localhost:53682/callback  and set
 *      "Allow public client flows" = Yes.
 *   3. Copy the Application (client) ID.
 *
 * Usage:
 *   CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx npm run outlook-auth
 *   # optional: TENANT=consumers PORT=53682 CLIENT_SECRET=... (confidential client)
 */

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET; // only for confidential clients
const TENANT = process.env.TENANT || "consumers"; // personal accounts
const PORT = Number(process.env.PORT || 53682);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
// Outlook reads via Microsoft Graph (Mail.Read) because personal accounts can't
// get IMAP tokens. Override with SCOPE=… to experiment.
const SCOPE = process.env.SCOPE || "https://graph.microsoft.com/Mail.Read offline_access";
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

if (!CLIENT_ID) {
  console.error(
    [
      "Missing CLIENT_ID.",
      "",
      "1. Register an Azure app (personal Microsoft accounts).",
      "2. Authentication → 'Mobile and desktop applications' → redirect URI:",
      `     ${REDIRECT_URI}`,
      "   and set 'Allow public client flows' = Yes.",
      "3. Then run:",
      "     CLIENT_ID=<your-app-client-id> npm run outlook-auth",
    ].join("\n"),
  );
  process.exit(1);
}

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
const state = base64url(crypto.randomBytes(16));

const authUrl =
  `${AUTH_BASE}/authorize?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_verifier: codeVerifier,
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not found");
    return;
  }

  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(400).end(`Auth error: ${err} — ${url.searchParams.get("error_description") || ""}`);
    console.error(`\n❌ ${err}: ${url.searchParams.get("error_description")}`);
    server.close();
    process.exit(1);
  }

  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("State mismatch or missing code.");
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchangeCode(code);
    res.writeHead(200, { "content-type": "text/html" }).end(
      "<h2>✅ Success — you can close this tab and return to the terminal.</h2>",
    );

    const snippet = {
      email: "REPLACE_WITH_THE_ACCOUNT_EMAIL@outlook.com",
      authType: "oauth2",
      oauth: {
        clientId: CLIENT_ID,
        ...(CLIENT_SECRET ? { clientSecret: CLIENT_SECRET } : {}),
        refreshToken: tokens.refresh_token,
        tenant: TENANT,
      },
    };

    console.log("\n✅ Got a refresh token. Add this entry to accounts.json:\n");
    console.log(JSON.stringify(snippet, null, 2));
    if (!tokens.refresh_token) {
      console.warn(
        "\n⚠️  No refresh_token returned — ensure the 'offline_access' scope was granted.",
      );
    }
    console.log("\n(Set the real email address in the snippet above.)");
  } catch (e) {
    res.writeHead(500).end(String(e));
    console.error("\n❌", e.message || e);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("\nOpen this URL, sign in as the Outlook account, and consent:\n");
  console.log(authUrl + "\n");
  // Best-effort auto-open (macOS: open, Linux: xdg-open, Windows: start).
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`, () => {});
});
