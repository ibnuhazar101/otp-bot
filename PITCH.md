# Pitch: Automated OTP Retrieval Service

A working prototype that replaces the manual, appointment-based way admins
retrieve login codes today — with a self-service lookup that returns codes in
seconds, scales to many accounts, and adds an audit trail we don't have now.

> Status: **working prototype**, tested against real Gmail, custom-domain
> (Niagahoster/cPanel), and Outlook accounts across ChatGPT, Canva, and Spotify.

---

## The problem today

OTP retrieval is a manual bottleneck:

- Admins keep a **separate Chrome Portable per email account** — dozens/hundreds
  of browser profiles to set up, stay logged into, and maintain.
- Users **book an appointment** and wait for an admin to be free.
- The admin **opens the right profile, searches the inbox, and reads the code**
  back by hand.

What it costs:

- **Admin time** — every code consumes a person; ~200 requests/day is hours of
  skilled staff doing copy-paste.
- **Delay** — users wait on human availability instead of seconds.
- **Doesn't scale** — more accounts = more browser profiles = more admin load.
- **No audit trail** — no record of who requested which code, when.
- **Privacy exposure** — admins have full, open access to every inbox.
- **Fragility** — browser sessions expire; knowledge lives in a few heads.

---

## The solution

A small service that connects to the mailboxes automatically and exposes OTPs
through a simple request — no browsers, no admin in the loop.

- Reads the OTP directly from the mailbox **on demand** when requested.
- Returns the latest valid code in **seconds** (warm) — a few seconds cold.
- Handles **all accounts from one service** — no per-email browser profiles.
- **Logs every request** (who, which account, which provider, when).
- A **one-page web UI**: pick account + provider → **Get OTP** → copy the code.
- A **credential-health check** so dead logins are visible, not silent.

---

## Before → After

| | Today (manual) | With the service |
|---|---|---|
| Who retrieves the code | An admin, per request | Self-service, automatic |
| Wait time | Appointment + lookup | ~seconds |
| Per-account setup | 1 Chrome Portable each | 1 config line each |
| Scales to more accounts | More admin work | Effectively free |
| Audit trail | None | Every request logged |
| Admin inbox access | Full, always | Not needed |

---

## What's proven

- **On-demand fetch** — no always-on connections; idle accounts cost nothing, so
  it scales to thousands of stored accounts at ~200 requests/day.
- **Provider templates** — ChatGPT, Canva, Spotify (add more via one config
  entry). Server-side sender+subject search finds the code anywhere in the inbox
  and skips look-alike notifications.
- **Three mailbox types**, all working against real accounts:
  - **Gmail** — IMAP + app password.
  - **Custom domain (e.g. seakun.xyz)** — IMAP + mailbox login password.
  - **Outlook** — Microsoft Graph API + OAuth2.

---

## The honest caveats (and the plan)

These are the questions leadership will ask — better to name them:

1. **Security / access control.** The prototype has **no auth** on the API and
   stores credentials in a local file. Production needs: API authentication,
   encrypted credential storage (secrets manager), and role-based access.
2. **Credential governance.** All accounts must be company-owned/authorized.
   Gmail/.xyz use app or login passwords; **Outlook needs a one-time OAuth
   consent per account** (Microsoft's requirement — there is no password path
   for Outlook anymore). App passwords / tokens can be revoked host-side, so we
   need monitoring + a re-provisioning workflow (health check already built).
3. **Reliability.** Single service today; production adds monitoring, alerting,
   and per-account health dashboards.
4. **Platform dependency.** Relies on Gmail app passwords and Microsoft OAuth
   staying available; both are supported today but worth tracking.

---

## Effort & cost

- **Prototype:** done.
- **Production-ready** (auth + secret storage + monitoring): days, not months.
- **Infra:** tiny — one small server handles this load; no database.
- **Ongoing:** near-zero admin time vs. today's daily hours.

---

## The ask

A phased rollout:

1. **Pilot** — run the prototype for a small set of accounts + a few users;
   measure time saved and reliability.
2. **Harden** — API auth, encrypted credential storage, monitoring/alerting.
3. **Roll out** — migrate off Chrome Portables, retire the appointment process.
   At larger scale, consider a catch-all domain + inbound-email webhook to drop
   per-account IMAP/OAuth entirely.

---

**Headline:** *We replace hours of daily admin copy-paste and appointment
scheduling with a self-service lookup that returns codes in seconds, scales to
any number of accounts, and adds an audit trail we don't have today — from a
prototype that already works across Gmail, custom domains, and Outlook.*
