# OpenChannels — agent instructions

One inbox over every channel you (the agent) sit on. **You own the channels the
app can't reach; the app owns storage, the human view, and any channel it can
send on itself.**

WhatsApp runs through the org's connected integration, so the app sends there
directly and a human's message goes out the moment they click Send. You are not
in that path — don't relay it, don't confirm it. Everything else still queues to
`/api/outbox` for you.

## Division of labour

- **Mirror, don't summarize.** Post the raw message body to `/api/ingest` and
  let the app store and render it. Never rewrite or condense a contact's words.
- **Only send what the outbox gives you.** Never send a channel message because
  you saw it in a thread — the only messages you send on this app's behalf are
  the items returned by `GET /api/outbox`. Never confirm `sent` without having
  actually sent. An outbound message already marked `sent` or `failed` has been
  handled by the app; leave it alone.
- **Respect channel permissions.** Sending always goes through your normal
  channel tools, so allowlists and approval rules still apply. If a send is
  blocked, report it as `failed` with the reason — don't work around it.
- **Don't manage templates.** The app pulls its own approved-template catalogue
  from the org's connected WhatsApp integration (`POST /api/templates/refresh`).
  You never sync, cache or curate it. If someone says the picker is empty, tell
  them to hit Refresh in the composer, or call that endpoint once yourself.
- **An outbox item with `template` is a template send.** Send it through the
  channel's *template* API with that exact name, language and variables. Never
  send its `body` as text: the body is the rendered preview for humans, and
  freeform is precisely what the 24-hour window forbids.

## Procedure 1 — mirror every channel message

Whenever a message arrives on (or is sent from) a channel you manage, and once
per conversation when backfilling history:

1. `POST /api/ingest` with:
   - `channel`: `whatsapp` | `telegram` | `slack` | `email` | `sms` | `linkedin` | `other`
   - `contact`: `{ handle, name? }` — the channel-native address (phone, email,
     @username; for LinkedIn the public profile URL, `linkedin.com/in/<slug>`)
     and display name if known
   - `message`: `{ kind: "inbound" | "outbound", body, externalId?, at? }` —
     `externalId` is the channel's own message id (repeats are dropped, so
     re-ingesting is always safe); `at` is the original ISO timestamp for
     history backfill; use `kind: "outbound"` for messages you already sent
   - `subject`: email subject, when there is one
2. When you *act* on a conversation (book something, draft something, escalate,
   update a record), log one short line:
   `POST /api/conversations/:id/events` with `{ body: "Booked the Thursday 10:00 slot" }`.
   These render as the audit trail the human reviews — every meaningful action
   gets one.

## Procedure 2 — send queued replies

On a heartbeat, or when asked to "check the inbox":

1. `GET /api/outbox` — each item has `message.body`, `channel`,
   `contact.handle`, `subject` (email only), and `template` (or `null`).
2. Send it to that contact **through the channel's own tool** (LinkedIn: see
   below — `opening` items go to 1st-degree connections only):
   - `template` is `null` → send `message.body` as a normal text message.
   - `template` is set → send it as a **template**, passing `template.name`,
     `template.language` and `template.variables` straight through (e.g.
     `WHATSAPP_SEND_TEMPLATE_MESSAGE`). Do **not** send `message.body`.
3. Confirm: `POST /api/messages/{message.id}/status` with
   `{ "status": "sent" }`, or `{ "status": "failed", "error": "<why>" }` if the
   send didn't happen. Unconfirmed items stay queued and will be handed to you
   again.

## LinkedIn: connections only, from your own browser

LinkedIn has no messaging API for a member account. You read and send LinkedIn
messages in **your own browser, already signed in to the org's LinkedIn
account** — the same session you use for anything else on LinkedIn. The rules
are stricter than on other channels, because an account that looks automated is
what LinkedIn restricts, and the account is a person's.

- **Stay inside your browser session.** Work through the pages, or through the
  requests LinkedIn's own messaging page makes, from inside that page. Never
  copy the session cookie out, never store or send it anywhere, never sign in
  with a password, and never install a library that does any of that. If you
  are signed out, stop and report it.
- **Mirror (Procedure 1), at a person's pace.** On each heartbeat, open the
  messaging inbox and ingest only messages newer than the last one you
  mirrored. `contact.handle` is the member's public profile URL
  (`https://www.linkedin.com/in/<slug>`); never a `/sales/…` link. Use
  LinkedIn's own id for the message as `externalId`, so a re-read is harmless.
  Mirror your account's own messages in those threads as `kind: "outbound"`.
- **Send only what the outbox gives you (Procedure 2).** LinkedIn items are
  always plain text written by a person in the app. You never write a LinkedIn
  message yourself, never send a connection request or InMail, and never
  message anyone the outbox did not name.
- **An `opening: true` item goes to connections only.** It is the first message
  in that thread. Before sending, open the person's profile and confirm they
  are a **1st-degree connection**. If they are not — or you cannot tell — send
  nothing and mark it
  `{ "status": "failed", "error": "Not a LinkedIn connection" }`. Never send a
  connection request to make it possible. The app allows one opening message
  per thread and nothing more until the person replies.
- **Stop at any wall.** A sign-in page, a CAPTCHA or security check, a
  "you're sending too many messages" notice, or any restriction banner: send
  nothing more this heartbeat, mark each item you could not send
  `{ "status": "failed", "error": "<what LinkedIn showed>" }`, and tell the
  user. Never retry through it or work around it.
- **Pace.** A few messages per heartbeat at most, with pauses between them.
  Anything left stays queued for the next one.
- **Daily limits are the app's job.** The outbox holds back LinkedIn items once
  the account has sent its daily share (50 messages and 20 opening messages
  over a rolling 24 hours, unless the org changed them). An empty outbox means
  wait, not a fault; never send LinkedIn messages from anywhere else to catch
  up. Always confirm `sent` promptly: the limits count confirmed sends.

## The 24-hour window (why some threads are template-only)

WhatsApp only lets a business send freeform text within 24 hours of the
contact's **last inbound** message. Outside that — and to a contact who has
never written — only a Meta-approved template goes out. The app enforces this
itself, so you don't have to reason about it:

- Humans see the composer switch to a template picker; the thread shows a
  "Template only" badge.
- Your `POST /api/conversations/:id/reply` gets a `409` if you send `body` to a
  shut thread. That is not retryable — send `template` instead.
- The app keeps its own catalogue fresh from the connected integration, so
  "there are no templates" is an integration problem, not a sync you owe.

## People: this inbox is not the CRM

A contact row here is a **channel identity** — one address on one channel. The
same human on WhatsApp and email is two rows. The *person* lives in whichever
app the org uses as its system of record, and that app owns them: their name,
their history, whether they still want to hear from you.

So a contact can carry a **link** to that person — an app id and a record id,
nothing else. Never copy the record in. A name mirrored here is a second source
of truth that goes stale silently and quietly contradicts the CRM.

**Configure it once** with `PUT /api/profile-source`. Every path and field name
below is an *example* — read the target app's `GET /api/openapi.json` and use
what it actually serves. One org's people app calls them customers, another's
calls them members, and the two disagree about everything else too:

```json
{ "appId": "<the sibling app's uuid>", "label": "Customers",
  "search": { "path": "/api/customers", "query": "q", "collection": "items" },
  "get":    { "path": "/api/customers/{ref}", "collection": "customer" },
  "fields": { "ref": "id", "name": "full_name", "phone": "mobile", "email": "email" },
  "profileUrl": "https://<that app>.apps.clawnify.com/customers/{ref}" }
```

Three things people get wrong:

- **`collection` is per operation, not per app.** A list endpoint returning
  `{"items": [...]}` and a detail endpoint returning `{"customer": {...}}` is
  normal — set it separately on `search` and `get`, and omit it entirely when
  the response *is* the array or the record.
- **`query` is that app's search parameter**, whatever it's called — `q`,
  `search`, `filter`. Get it from the spec, not from habit.
- **`fields` maps meaning onto their names.** `fields.ref` must name the id you
  will link to; the rest are optional and only affect display.

It is verified against the live app before it saves, so a wrong path or a wrong
`fields.ref` comes back as a `422` naming the problem rather than a picker that
is mysteriously always empty.

**Then link contacts as you learn who they are.** On ingest, add
`contact.linked: { appId, ref }` when you already know the person — you looked
the number up to answer them anyway. Only when you *know*:

- A confident match on a full phone number or email address is a link.
- A name that merely looks similar is **not**. Two people share a surname; a
  household shares a phone. A wrong link is worse than no link, because it
  silently attributes one person's conversation to another.
- Omitting `linked` never clears an existing link — absence means "didn't look
  it up", not "no longer linked". To correct a bad link, send the right one.

Humans get the same thing from the other end: starting a conversation, they
search the people app and pick someone, which fills the address and sets the
link. `GET /api/contacts/:id/profile` resolves a linked contact live — use it
instead of remembering what a member's phone number was last week.

## Pages

Every view is a real URL, so you can open one directly instead of clicking
through to it, and a screenshot always has a link that reproduces it.

- `/` — the whole open inbox (nav → conversation list → thread).
- `/ch/<channel>` — one channel, e.g. `/ch/whatsapp`.
- `/closed` — the closed archive.
- `/setup` — WhatsApp numbers and the template catalogue.
- `/c/<conversationId>` — one thread, open.
- Append `?agent` when browsing it yourself for larger targets.

## API anchors

Discovery: `GET /llms.txt` / `GET /api/openapi.json`. The shapes you'll write
most: `POST /api/ingest` and `POST /api/messages/:id/status` (above). Also
there when needed: `GET /api/conversations` (paginated, `?search=`),
`GET /api/conversations/:id/messages`, `POST /api/conversations/:id/comment`
(internal note), `PATCH /api/conversations/:id` (`{"status":"closed"}`).

## Failures

- `401` — the request lost its org identity: call the app through your app API
  tool, never with raw fetch.
- `403` on ingest — only agent/API callers may ingest.
- `duplicate: true` from ingest is success, not an error (idempotency did its job).
- `409` on reply — the 24-hour window is shut. Not retryable: send a template
  instead. (Humans see this as the composer switching to template-only.)
- `422` on reply — the template is unknown, not `APPROVED`, or missing variable
  values. Hit `POST /api/templates/refresh` before assuming the name is wrong;
  Meta may have paused or renamed it.
- `422` on `PUT /api/profile-source` — the target app didn't answer as described.
  The message says which part: a 404 means the `appId` isn't an app in this org,
  and a missing `fields.ref` means you named a field the records don't have.
- `409` on `/api/contacts/:id/profile` — that contact isn't linked, or no
  profile source is configured. Not an error to retry.
- `424` on profile search or resolve — the people app itself was unreachable or
  errored. The inbox keeps working; only the lookup is down.
