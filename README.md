# otp-bot

A minimal **OTP retrieval service** (MVP / prototype).

An admin/user picks a **mailbox** and a **provider** (ChatGPT, Canva, Spotify…),
and the service fetches the latest verification code for that combination from
the mailbox **on demand** over IMAP, and returns it through a small REST API and
a one-page web UI.

It replaces the manual process of keeping a separate browser profile per email
and having an admin open each one to read codes by hand.

> ⚠️ **Prototype.** No database, no queue, and **no auth on the REST endpoint**.
> Run it only on a trusted network with test accounts.

---

## How it works

```
Browser (pick email + provider)
        │  GET /otp/:email?provider=chatgpt
        ▼
   Express API ─────────────► OtpFetcher (on demand)
                                 │  1. connect to the mailbox (warm-cached)
                                 │  2. IMAP SEARCH by sender (+ subject)
                                 │  3. download newest FETCH_LIMIT matches
                                 │  4. regex: senderPattern + otpRegex
                                 ▼
                          newest matching code → JSON
```

Key design points:

- **On demand, not always-on.** No persistent IMAP connections. A mailbox is
  contacted only when a request comes in, so idle accounts cost nothing and the
  service scales to many accounts.
- **Account = credentials, provider = template.** [accounts.json](accounts.example.json)
  holds mailbox credentials; [providers.json](providers.example.json) holds the
  rules (sender/subject/regex) for each service. A request combines the two.
- **Server-side narrowing.** An IMAP `SEARCH` filters by the provider's sender
  (and optionally subject) *before* downloading, so we fetch only that provider's
  mail — found anywhere in the inbox, not just the newest N messages.
- **Warm connections + single-flight.** A connection is kept warm briefly so
  repeat clicks reuse it; concurrent identical requests collapse into one fetch.

See [IMAP_FILTERS.md](IMAP_FILTERS.md) for the full list of IMAP search/fetch
options and how the provider fields map to them.

---

## Supported mailboxes

| Type | Transport | Auth | Config |
|------|-----------|------|--------|
| **Gmail** | IMAP | App password | `email` + `appPassword` (host auto-detected) |
| **Custom domain (.xyz etc.)** on a generic IMAP host | IMAP | Login/app password | `+ imapHost` (and `imapPort` if not 993) |
| **Outlook / personal Microsoft** | **Microsoft Graph** | **OAuth2** | `authType: "oauth2"` + `oauth{…}` — see [Outlook setup](#outlook-setup) |

The transport is chosen automatically per account:

- **Gmail / generic hosts → IMAP** with an app or login password.
- **Outlook → Microsoft Graph API** (`GET /me/messages`). Microsoft disabled Basic
  Auth for IMAP on personal accounts (Sept 2024), *and* personal-account Azure
  directories can't issue IMAP OAuth tokens at all — so Outlook is read via
  Graph with a `Mail.Read` OAuth token instead. Providers, subject/sender
  matching, and OTP extraction are identical across both transports.

---

## Prerequisites

- Node.js 18+
- **Gmail**: 2-Step Verification on, then create an **App Password**
  (Google Account → Security → App passwords).
- **Outlook**: an Azure app registration + a refresh token per account
  (see [Outlook setup](#outlook-setup)).

---

## Setup

```bash
npm install

cp .env.example .env                       # global settings
cp accounts.example.json accounts.json     # mailbox credentials (git-ignored)
cp providers.example.json providers.json   # provider templates
# edit accounts.json / providers.json
```

### accounts.json

```json
[
  { "email": "you@gmail.com", "appPassword": "abcd efgh ijkl mnop" },

  { "email": "you@mydomain.xyz", "appPassword": "…",
    "imapHost": "mail.mydomain.xyz", "imapPort": 993 },

  { "email": "you@outlook.com", "authType": "oauth2",
    "oauth": { "clientId": "…", "refreshToken": "…", "tenant": "common" } }
]
```

Generate the Outlook `oauth` block with `npm run outlook-auth` — see [Outlook setup](#outlook-setup).

| Field | Required | Notes |
|-------|----------|-------|
| `email` | yes | Mailbox address; also the key in the API/UI. |
| `appPassword` | for password auth | Gmail app password / mailbox login password. |
| `imapHost` | for unknown domains | e.g. `srv101.niagahoster.com`. Auto-detected for gmail/outlook. |
| `imapPort` | no | Defaults to 993. |
| `authType` | no | `password` (default) or `oauth2`. Auto-set to `oauth2` for Outlook hosts. |
| `transport` | no | `imap` (default) or `graph`. Auto-set to `graph` for Outlook. |
| `accessToken` | oauth testing | A raw short-lived token (skips the refresh flow). |
| `oauth` | oauth2 | `{ clientId, clientSecret?, refreshToken, tenant?, scope?, tokenUrl? }` |

### providers.json

```json
[
  {
    "name": "chatgpt",
    "label": "ChatGPT / OpenAI",
    "senderPattern": "noreply@tm\\.openai\\.com|ChatGPT",
    "imapFrom": "tm.openai.com",
    "imapSubject": ["login code", "verification code"],
    "otpRegex": "code to continue[^0-9]{0,40}(\\d{4,8})"
  }
]
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Key used in requests (`?provider=chatgpt`). |
| `label` | no | Shown in the UI dropdown. |
| `senderPattern` | yes | Regex matched (case-insensitive) against From + Subject — the precise client-side check. |
| `otpRegex` | yes | Regex extracting the code; **capture group 1** preferred. |
| `imapFrom` | no | Substring for the server-side IMAP `FROM` search (find mail anywhere in the inbox). |
| `imapSubject` | no | Server-side subject filter. **String or array** (array = OR / different languages). |

> Regexes are JSON strings — escape backslashes (`\\d`, `\\b`).
> `accounts.json` and `.env` are git-ignored; `providers.json` is safe to commit.

---

## Run

```bash
npm run dev          # auto-reload, then open http://localhost:3000
# or
npm run build && npm start
```

Open **http://localhost:3000**, pick an account + provider, click **Get OTP**.
One check per click — if nothing's found yet, click again once the email lands.
The **Account health** widget shows which credentials are alive.

---

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /` | The web UI. |
| `GET /otp/:email?provider=<name>` | Latest OTP for that mailbox/provider, or `404`. |
| `GET /accounts` | Configured account emails (feeds the dropdown). |
| `GET /providers` | Configured providers (feeds the dropdown). |
| `GET /accounts/:email/health` | Checks one account; reports `ok` / `auth_failed` / `error`. |
| `GET /accounts/health` | Checks every account (same statuses, with a summary). |
| `GET /health` | Liveness. |

**Example**

```bash
curl "http://localhost:3000/otp/you@gmail.com?provider=chatgpt"
```

```json
{
  "email": "you@gmail.com",
  "provider": "chatgpt",
  "code": "750484",
  "from": "\"ChatGPT\" <noreply@tm.openai.com>",
  "subject": "Your temporary ChatGPT login code",
  "receivedAt": "2026-09-02T09:40:43.000Z",
  "expiresAt": null
}
```

`404` when no matching OTP is found; `400` for a missing/unknown provider;
`502` for auth/upstream failures. Pass an `X-Requester` header to tag who's
asking (logged with each request).

---

## Configuration (.env)

| Var | Default | Meaning |
|-----|---------|---------|
| `HOST` / `PORT` | `0.0.0.0` / `3000` | API bind address. |
| `IMAP_HOST` / `IMAP_PORT` | – / `993` | Fallback host/port for unknown domains (per-account `imapHost` and domain detection take precedence). |
| `OTP_RECENCY_SECONDS` | `0` | Max age for a code to count. **0 = disabled** (return newest match regardless of age — prototype default). |
| `FETCH_LIMIT` | `3` | How many matching messages to download per request (the newest N of the search results). |
| `WARM_CONNECTION_SECONDS` | `120` | How long an idle IMAP connection is kept warm for repeat clicks. |
| `ACCOUNTS_FILE` / `PROVIDERS_FILE` | `accounts.json` / `providers.json` | Config file paths. |

---

## Outlook setup

Outlook is read via the **Microsoft Graph API**, not IMAP. Why: Microsoft
disabled Basic Auth for IMAP on personal accounts (Sept 2024), and an Azure app
registered in a **personal-account "default directory" can't issue
`outlook.office365.com` (IMAP) OAuth tokens at all** — the Exchange Online
resource doesn't exist there (you'll hit `invalid_scope` / "the provided
resource value ... is not valid"). Microsoft **Graph** *is* available in every
directory, so we use `Mail.Read` + `GET /me/messages` instead.

### One-time: register an Azure app (free — no subscription needed)

App registration lives in **Microsoft Entra ID** (free tier); the Azure portal's
subscription prompt is for paid *resources* and doesn't apply. Go to
[entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New
registration**.

1. **Supported account types**: *Personal Microsoft accounts only* (or *Any
   Entra ID tenant + Personal Microsoft accounts*).
2. **Authentication** → **Add a platform → Mobile and desktop applications** →
   redirect URI **`http://localhost:53682/callback`**; set **"Allow public
   client flows" = Yes**. (No client secret needed — public client + PKCE.)
3. **API permissions** → **Add a permission → Microsoft Graph → Delegated →
   `Mail.Read`** → Add. (This one is in the picker, unlike the Exchange/IMAP
   permission.)
4. Copy the **Application (client) ID**.

### Per account: get a refresh token

```bash
CLIENT_ID=<application-client-id> TENANT=common npm run outlook-auth
```

The helper opens a browser, you sign in as the Outlook account and click
**Accept**, and it prints a ready-to-paste `accounts.json` snippet with the
refresh token. Set the real email and add it to `accounts.json`, then verify:

```bash
curl "http://localhost:3000/accounts/you@outlook.com/health"   # {"status":"ok","host":"graph.microsoft.com"}
```

The service exchanges the refresh token for Graph access tokens automatically
and caches them. Repeat this step per Outlook account (same `CLIENT_ID`). For a
quick test you can instead paste a raw short-lived `accessToken` and skip the
refresh flow.

> Refresh tokens for personal accounts last ~90 days of inactivity and can be
> revoked by password changes — use `GET /accounts/:email/health` to detect
> dead ones.

---

## Logging

Console, one event per line with an ISO timestamp. Notable events:
`config.loaded`, `imap.connecting`, `imap.connected`, `imap.closed`,
`oauth.refresh`, `otp.request_scan`, `otp.request`, `accounts.health`,
`imap.auth_failed`.

---

## Latency

- **Cold request** (no warm connection): ~3–4s — dominated by the IMAP connect
  (TLS + login round-trips to the mail host).
- **Warm request** (within `WARM_CONNECTION_SECONDS`): ~0.5–1s.

The frontend does one request per click; the flow is: trigger a login → wait for
the email → click **Get OTP**.

---

## Known limitations (intentional for the MVP)

- No auth / rate limiting on the REST API.
- Credentials stored in a local file (encrypt / use a secrets manager for prod).
- App passwords / OAuth tokens can be revoked host-side — use `GET /accounts/health`
  to detect dead credentials.
- Recency disabled by default (returns the newest match regardless of age).
- Outlook requires per-account OAuth consent (Microsoft's requirement).

## Next steps toward production

- API authentication + rate limiting.
- Encrypted credential storage (secrets manager).
- Alerting on `imap.auth_failed` / `accounts/health` for dead credentials.
- Optional: lighter fetch (headers + text part) and a small pre-warmed pool.
- Consider a catch-all domain + inbound-email webhook to avoid per-account
  IMAP entirely at scale.
