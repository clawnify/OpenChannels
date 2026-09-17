import { sqliteTable, text, integer, index, uniqueIndex } from "@clawnify/db";

/**
 * open-channels — one inbox over every channel the org's agent sits on.
 *
 * Data flows in from the agent (POST /api/ingest): the agent mirrors every
 * inbound/outbound channel message here. Replies composed in the UI are
 * written as `outbound` messages with status `queued`; the agent picks them
 * up from GET /api/outbox, sends them through its own channel tools, and
 * confirms via POST /api/messages/:id/status. The app never talks to a
 * channel API directly.
 *
 * Multi-tenancy: every table carries org_id and every query filters by it.
 */

/** A person on the other end of a channel, unique per (org, channel, handle). */
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    /** Channel this contact lives on: whatsapp | telegram | slack | email | sms | linkedin | other */
    channel: text("channel").notNull(),
    /** Channel-native address: phone number, email address, @username, member id. */
    handle: text("handle").notNull(),
    /**
     * The curated label — what WE call this person. Human-set, and never
     * touched by ingest: a name someone typed must survive every inbound
     * message, and a deliberate blank must stay blank.
     */
    name: text("name"),
    /**
     * What THEY call themselves — the channel's own profile name, refreshed
     * from each inbound message. Kept separate from `name` because provider
     * data would otherwise silently overwrite human intent, and an empty
     * `name` would be indistinguishable from "not set yet".
     */
    profileName: text("profile_name"),
    avatarUrl: text("avatar_url"),
    /**
     * The person this channel identity belongs to, in the org's own system of
     * record — a sibling Clawnify app (its UUID) and the record's id there.
     *
     * This row is a *channel identity* (unique per org+channel+handle), not a
     * person: the same human on WhatsApp and email is two rows. The org's CRM
     * owns the person. So we store a link, never a copy — no name, no notes,
     * no phone mirrored here. Display data is read live through the app-to-app
     * proxy so it cannot go stale, and deleting the CRM record breaks the link
     * loudly instead of leaving a plausible-looking fossil behind.
     *
     * Stored as the app's platform UUID rather than a free-text source name so
     * it stays resolvable and validatable. Both null until someone links this
     * contact; nothing in the inbox requires them.
     */
    linkedAppId: text("linked_app_id"),
    linkedRef: text("linked_ref"),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgHandle: uniqueIndex("contacts_by_org_channel_handle").on(t.orgId, t.channel, t.handle),
  }),
);

/** One thread with one contact on one channel. */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    contactId: text("contact_id").notNull(),
    channel: text("channel").notNull(),
    /** Email subject line; null for chat channels. */
    subject: text("subject"),
    /** open | closed */
    status: text("status").notNull().default("open"),
    /** 1 when the latest inbound message hasn't been seen in the UI. */
    unread: integer("unread").notNull().default(0),
    lastMessageAt: text("last_message_at").notNull().$default(() => new Date().toISOString()),
    lastMessagePreview: text("last_message_preview").notNull().default(""),
    /**
     * The dashboard user who owns this thread, so a shared inbox doesn't drop
     * balls. `assigneeName` is a display snapshot — names change in Supabase
     * and there is no live "user" table here to resolve against — while
     * `assigneeId` stays the stable identity for "mine" filters.
     */
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgRecency: index("conversations_by_org_recency").on(t.orgId, t.lastMessageAt),
    byOrgAssignee: index("conversations_by_org_assignee").on(t.orgId, t.assigneeId),
    byOrgContact: uniqueIndex("conversations_by_org_contact").on(t.orgId, t.contactId),
  }),
);

/**
 * Small per-org key/value settings.
 *
 * Currently one key — `whatsapp_default_phone_number_id`, the number outbound
 * WhatsApp goes out from. Once a WABA has more than one registered number,
 * "pick the first" is not a default, it's whichever order the provider
 * happened to return; the sending identity a customer sees is too visible to
 * leave to that.
 */
export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgKey: uniqueIndex("settings_by_org_key").on(t.orgId, t.key),
  }),
);

/**
 * Approved channel message templates, mirrored in by the agent.
 *
 * WhatsApp Business only lets you open a conversation (or re-engage one whose
 * 24-hour customer service window has lapsed) with a template Meta has
 * approved. The app never calls Meta — the agent syncs the catalogue in via
 * POST /api/templates/sync, exactly as it mirrors messages, so switching
 * provider (Cloud API, Composio, Bird) never touches this app.
 */
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    /** Channel the template belongs to — whatsapp today; the gate is per-channel. */
    channel: text("channel").notNull(),
    /** Meta template name, e.g. "appointment_reminder_v1". */
    name: text("name").notNull(),
    /** Meta language code, e.g. "en_US". A name exists once per language. */
    language: text("language").notNull(),
    /** AUTHENTICATION | MARKETING | UTILITY */
    category: text("category").notNull(),
    /** APPROVED | PENDING | REJECTED | DISABLED | PAUSED | LIMIT_EXCEEDED */
    status: text("status").notNull(),
    /** BODY component text, placeholders intact — what the composer previews. */
    bodyText: text("body_text").notNull().default(""),
    /** Ordered placeholder tokens in bodyText: ["1","2"] or ["first_name"]. */
    variables: text("variables").notNull().default("[]"),
    /** Meta's full components array (HEADER/BODY/FOOTER/BUTTONS), verbatim JSON. */
    components: text("components").notNull().default("[]"),
    /** Meta's own template id, for provenance and dedupe across renames. */
    externalId: text("external_id"),
    syncedAt: text("synced_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgChannelNameLang: uniqueIndex("templates_by_org_channel_name_language").on(
      t.orgId,
      t.channel,
      t.name,
      t.language,
    ),
    byOrgChannel: index("templates_by_org_channel").on(t.orgId, t.channel, t.status),
  }),
);

/**
 * Everything that happens in a thread, in one timeline:
 *   kind=inbound   — a message from the contact
 *   kind=outbound  — a message to the contact (status: queued → sent | failed)
 *   kind=system    — an agent action audit line ("Drafted a reply", "Escalated…")
 *   kind=comment   — an internal note, never delivered to the contact
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    /** Display name of who wrote it: the contact, "Agent", or a dashboard user's name. */
    authorName: text("author_name"),
    /** Dashboard user id when a signed-in person wrote it (reply or comment). */
    userId: text("user_id"),
    /** Outbound delivery state: queued | sent | failed. Null for other kinds. */
    status: text("status"),
    /** Failure detail when status=failed. */
    error: text("error"),
    /** Channel-native message id — makes ingest idempotent. */
    externalId: text("external_id"),
    /**
     * A picture, voice note or document that came with this message.
     *
     * `mediaRef` is how the channel names the file, and the two shapes differ:
     * Meta sends `whatsapp-media:<id>`, an id that must be exchanged for a
     * short-lived download URL, while Bird sends a plain URL. Neither is worth
     * anything once fetched, so this is a reference to resolve, not a link to
     * render — the fetched bytes get their own key once storage is on.
     *
     * Recorded even before we can fetch, because Meta keeps media for about 30
     * days: an id we wrote down can still be backfilled, and one we dropped is
     * gone. This column exists because an ingest that read only `content.text`
     * kept the caption of an inbound photo and silently lost the photo.
     */
    mediaRef: text("media_ref"),
    /** image | audio | video | document — what the channel said it was. */
    mediaType: text("media_type"),
    /**
     * The app's own storage key once the bytes have been fetched and kept.
     *
     * `mediaRef` is the channel's reference, and both shapes of it expire —
     * Meta keeps media for about 30 days, Bird URLs for less. `mediaKey` is
     * the durable copy under the app's own bucket, and it is what the timeline
     * renders from. Unset means the attachment has not been (or cannot be)
     * fetched yet: the ref is still recorded, so a later pass can backfill.
     */
    mediaKey: text("media_key"),
    /** MIME type of the stored bytes, served back as-is on download. */
    mediaMime: text("media_mime"),
    /** Original filename when the channel supplied one. */
    mediaName: text("media_name"),
    /**
     * Template send (outbound only, null for freeform). The agent MUST send
     * these through the template API with these exact values — `body` holds the
     * rendered text for humans to read, and sending that as freeform would be
     * rejected outside the 24-hour window.
     */
    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    /** JSON object of placeholder token → value, e.g. {"1":"Kara"}. */
    templateVariables: text("template_variables"),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
    /**
     * When the message actually left, as opposed to when it was queued: set
     * when the agent confirms a send, or from the original time of a message
     * the agent mirrored in as already sent. The LinkedIn daily limits count on
     * this, because a message can sit in the queue for days.
     */
    sentAt: text("sent_at"),
    /** 1 when a person queued this as the first message in a thread nobody had answered (LinkedIn). */
    opening: integer("opening").notNull().default(0),
  },
  (t) => ({
    byConversation: index("messages_by_conversation").on(t.conversationId, t.createdAt),
    byOrgExternal: uniqueIndex("messages_by_org_external").on(t.orgId, t.externalId),
    byOrgQueued: index("messages_by_org_status").on(t.orgId, t.status),
  }),
);

/**
 * The org's LinkedIn sync: which agent mirrors the LinkedIn inbox and sends the
 * queued LinkedIn messages, how often, and whether it is on.
 *
 * The cadence itself lives in the agent's own scheduler (created through
 * @clawnify/agents); this row is the app's record of that schedule, so the app
 * can show it, pause it, change it or remove it. Never a second clock.
 *
 * Off until a person turns it on: every run spends the agent's credits.
 */
export const linkedinSync = sqliteTable("linkedin_sync", {
  orgId: text("org_id").primaryKey(),
  /** The agent (Clawnify server id) that owns the schedule. */
  serverId: text("server_id").notNull(),
  /** A key from SYNC_CADENCES: when the schedule fires. */
  cadence: text("cadence").notNull(),
  /** IANA time zone the cadence is read in, taken from the browser that set it. */
  timezone: text("timezone").notNull(),
  active: integer("active").notNull().default(0),
  /** The agent-side schedule id, once created. */
  scheduleId: text("schedule_id"),
  /** The last failure talking to the agent's scheduler, shown until it clears. */
  scheduleError: text("schedule_error"),
  /**
   * Idempotency key for creating the schedule. Kept, not regenerated, so a
   * retry after a timeout replays the same creation instead of adding a
   * second schedule. Renewed only when the schedule moves to another agent.
   */
  setupId: text("setup_id").notNull(),
  updatedAt: text("updated_at").notNull().$default(() => new Date().toISOString()),
});

/**
 * One sync run, opened by the agent when a scheduled (or "Run now") task
 * starts and closed by it when it ends. At most one runs per org at a time;
 * the partial unique index is what makes that true under overlapping fires.
 */
export const linkedinSyncRuns = sqliteTable(
  "linkedin_sync_runs",
  {
    /** Generated by the agent and reused on retry, so opening a run is idempotent. */
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** running | done | failed */
    status: text("status").notNull().default("running"),
    mirrored: integer("mirrored"),
    sent: integer("sent"),
    failed: integer("failed"),
    /** What stopped the run: a sign-in page, a limit notice, a timeout. */
    error: text("error").notNull().default(""),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => ({
    byOrg: index("linkedin_sync_runs_by_org").on(t.orgId, t.startedAt),
  }),
);
