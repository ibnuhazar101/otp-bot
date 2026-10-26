# IMAP filter reference

How the service finds and reads OTP emails, and the full set of filter/fetch
options available (via [imapflow](https://imapflow.com)). Two distinct steps:

1. **`search()`** — decide *which* messages to look at (server-side, at the mail host).
2. **`fetch()`** — decide *what data* to download from those messages.

The provider fields in `providers.json` map onto step 1 (server-side prefilter);
the `senderPattern` / `otpRegex` run in our code on the downloaded messages.

---

## How this service uses it

For a request `GET /otp/:email?provider=chatgpt`:

```
① IMAP SEARCH  { from: imapFrom, subject/or: imapSubject }   ← server-side, narrows to the provider
② take newest FETCH_LIMIT of the results                     ← our code
③ FETCH source of those messages                             ← download
④ senderPattern (regex) + otpRegex on each                   ← our code, precise match + extract
⑤ return the newest message whose code matched
```

- IMAP search can only do **substring** matching (no regex), so it's a coarse
  prefilter. The exact matching + digit extraction happens client-side (④).
- `imapFrom` → search `from`. `imapSubject` (string) → search `subject`.
  `imapSubject` (array) → an **OR** of subjects (see below).
- If a provider sets neither, we fall back to scanning the newest `FETCH_LIMIT`
  messages in the inbox.

Example compiled search for the `chatgpt` provider:

```js
client.search({
  from: "tm.openai.com",
  or: [ { subject: "login code" }, { subject: "verification code" } ]
})
// = from tm.openai.com AND (subject~"login code" OR subject~"verification code")
```

---

## `search()` — which messages (SearchObject)

All keys in one object are **AND**-ed together.

### Flags (boolean: `true` = has flag, `false` = lacks it)

| Key | Matches |
|-----|---------|
| `seen` | `\Seen` — `false` = **unread** |
| `answered` | `\Answered` |
| `flagged` | `\Flagged` (starred) |
| `draft` | `\Draft` |
| `deleted` | `\Deleted` |
| `recent` / `old` / `new` | `\Recent` state |
| `keyword` / `unKeyword` | a custom flag (string value) |
| `all` | matches everything |

### Text / address (substring match)

| Key | Field searched |
|-----|----------------|
| `from` | From: header |
| `to` / `cc` / `bcc` | recipient headers |
| `subject` | Subject: |
| `body` | message body |
| `text` | headers **and** body |
| `header` | `{ "x-name": true \| "substr" }` — arbitrary header |

### Dates (`Date` or `YYYY-MM-DD` string)

| Key | Based on |
|-----|----------|
| `since` / `before` / `on` | **received** date (INTERNALDATE); date-only ignores time |
| `sentSince` / `sentBefore` / `sentOn` | **Date:** header |

### Size / ranges / ids

| Key | Meaning |
|-----|---------|
| `larger` / `smaller` | message size in bytes |
| `seq` | sequence range, e.g. `"1:10"`, `"1,5,7"` |
| `uid` | UID range |
| `modseq` | changed since a modseq (CONDSTORE) |
| `emailId` / `threadId` | object IDs (Gmail / OBJECTID) |

### Combining logic

| Key | Meaning |
|-----|---------|
| *(multiple keys)* | **AND** — all must match |
| `or: [ …, … ]` | **OR** — at least one sub-query matches (each element is a full SearchObject) |
| `not: { … }` | **NOT** — must not match |

```js
// from a sender, unread, since a date, and (subject A OR subject B)
client.search({
  from: "no-reply@acme.com",
  seen: false,
  since: new Date(Date.now() - 3600_000),
  or: [ { subject: "code" }, { subject: "verification" } ]
})
```

### Gmail-only extras

| Key | Meaning |
|-----|---------|
| `gmraw` / `gmailraw` | a raw Gmail search string, e.g. `"from:acme newer_than:1h subject:code"` — the most expressive option on Gmail |
| `labels: { has: [...], not: [...] }` | filter by Gmail labels |

---

## `fetch()` — what data to download (FetchQueryObject)

Pull only what you need — this is the main bandwidth/latency lever.

| Key | Returns |
|-----|---------|
| `envelope` | parsed From/To/Subject/Date/Message-ID (cheap) |
| `internalDate` | server receive time |
| `flags`, `size`, `uid` | metadata |
| `bodyStructure` | MIME tree (which part is text/html) |
| `headers` | `true` = all, or `["subject","from"]` = only those |
| `bodyParts` | specific MIME parts, e.g. `["1"]` or `[{ key: "1", maxLength: 2048 }]` |
| `source` | **entire raw RFC822** message — `true` or `{ start, maxLength }` |
| `labels` / `threadId` | Gmail extras |
| `fast` / `all` / `full` | macros: flags+date+size / +envelope / +bodyStructure |

This service currently fetches `{ source: true, envelope: true, internalDate: true }`
and parses with `mailparser`. `source: true` downloads the whole message; a
lighter alternative is `envelope` + `bodyParts` for just the text part.

---

## Caveats

- **Substring only** — IMAP `SEARCH` cannot do regex. `from`/`subject`/`body`
  match substrings; the precise regex runs in our code after fetch.
- **Subject language variance** — providers may localise subjects (e.g. Canva's
  Indonesian "Kode masuk" vs an English "login code"). Use an `imapSubject`
  **array** to OR the variants, or omit `imapSubject` to match by sender only.
- **Encoded headers** — Gmail decodes MIME-encoded subjects for search; exotic
  encodings can occasionally be flaky.
- **Date granularity** — `since`/`before`/`on` ignore the time-of-day (whole-day
  resolution).
- **Org accounts** — Google Workspace / Microsoft 365 may restrict some features
  (e.g. external forwarding), unrelated to search but worth noting.
