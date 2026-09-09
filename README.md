<img src="readme-banner.png" alt="OpenChannels preview" />

# OpenChannels

**Every conversation your AI employee handles — WhatsApp, Telegram, Slack, email — in one inbox.**

[![Deploy to Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenChannels)

An open-source shared inbox built for teams whose first responder is an AI agent. Where classic shared inboxes exist so *humans* can answer everything, OpenChannels exists so a human can *review* everything: the agent triages, drafts, replies and logs what it did; you read one timeline per contact and jump in only when it matters.

## How it works

```
WhatsApp / Telegram / Slack / Email
        │  (channels the agent already sits on)
        ▼
  Clawnify agent ──ingest──▶  OpenChannels (this app)
        ▲                     conversations · messages · audit trail
        └────outbox◀──────    replies you compose in the UI
```

- **Ingest** — the agent mirrors every inbound/outbound channel message into the app (`POST /api/ingest`, idempotent per channel message id). History backfill uses the same call.
- **Audit trail** — every action the agent takes on a conversation ("Booked the appointment", "Escalated to Sara") lands as a system line inside the thread.
- **Replies are agent-mediated** — hitting *Send* queues the message; the agent picks it up from `GET /api/outbox`, sends it through the channel's own tools, and confirms delivery. The app has **no channel credentials and no send path of its own**, so your channel allowlists and approval rules keep applying.
- **Internal notes** — comment inside a thread without ever messaging the contact.

## Features

- Three-pane inbox: channel navigation (live counts) → conversation list (search, unread) → thread
- Every view is a URL (`/ch/whatsapp`, `/closed`, `/c/<id>`), so back, reload and cmd-click all behave
- One conversation per contact, closed threads reopen automatically on new inbound
- Queued / sent / failed delivery states on every outgoing reply
- Start a conversation by searching the people app you already have — point the
  inbox at it once and pick a person instead of typing a phone number. Contacts
  link to that record rather than copying it, so your CRM stays the one place a
  person's details live
- Multi-tenant by construction (org-scoped rows, platform-injected identity)
- Dark mode, agent mode (`?agent`), keyboard-friendly composer

## Deploy

Runs on the [Clawnify](https://clawnify.com) platform — the agent, channels, database and hosting come with it:

```bash
pnpm install
pnpm deploy        # → https://<slug>.apps.clawnify.com
```

Then tell your agent to read `agent.md` and start mirroring its channels.

## Local development

```bash
pnpm install
pnpm dev           # UI on :5173, API on :8787 (local SQLite)
```

The Vite proxy injects a local dev identity; seed data by curling `POST /api/ingest` with the same headers (see `agent.md` for the payload shape).

## Stack

Hono API + React + Vite over a SQLite database (Drizzle) — the standard Clawnify app template. API surface is OpenAPI-typed and self-documented at `/llms.txt` and `/api/openapi.json`.

## License

MIT
