import { OpenAPIHono, createRoute, z, user, orgId, caller } from "@clawnify/app";
import { connect } from "@clawnify/connections";
import { getDB, and, or, eq, desc, asc, lt, like, count, sql, inArray, isNull } from "@clawnify/db";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

// CLAWNIFY_TOKEN is the org service token, injected as a secret on every
// deploy. It is how this app reaches a sibling app in the same org (see
// callSibling). Optional in the type because a never-redeployed app predates
// the injection — the code degrades to "no profile source" rather than 500ing.
type Env = {
  Bindings: {
    DB: D1Database;
    CLAWNIFY_TOKEN?: string;
    /** Optional OpenCRM sibling used unless a profile source was configured. */
    CRM_APP_ID?: string;
    /**
     * The app's own object storage (R2), provisioned because clawnify.json
     * declares `app.storage: true`. Optional in the type: an app deployed
     * before that flag had no bucket, and every media feature degrades to
     * "keep the reference, show the filename" rather than 500ing.
     */
    UPLOADS?: R2Bucket;
    /** Integration-owned WABA configuration, injected at deployment. */
    WHATSAPP_BUSINESS_WABA_ID?: string;
  };
};
const api = new OpenAPIHono<Env>();

// getDB returns a D1 | Facet union whose generic select(fields) overloads
// collapse on the union type. Both backends share the same query surface, so
// narrow once here (type-only — drizzle-orm is a devDependency for this import).
type DB = DrizzleD1Database<typeof schema>;
const dbFor = (env: Env["Bindings"]) => getDB(env, { schema }) as DB;

// The token stays behind @clawnify/connections; the WABA is non-secret
// connection configuration needed to address Meta's WABA-scoped edges.
// This declaration also ensures connection changes are picked up on the next
// Open Channels-only deployment, including its refreshed bearer-token fallback.
const WHATSAPP_SERVICE = "whatsapp-business";
const META_GRAPH_VERSION = "v23.0";

function metaId(value: string | undefined, label: string): string {
  const id = value?.trim() ?? "";
  if (!/^\d+$/.test(id)) throw new Error(`${label} is not configured`);
  return id;
}

function whatsappBusiness(env: Env["Bindings"]) {
  return {
    client: connect(WHATSAPP_SERVICE, env as never),
    wabaId: metaId(env.WHATSAPP_BUSINESS_WABA_ID, "WhatsApp Business Account ID"),
  };
}

const wabaEndpoint = (wabaId: string, edge: string) =>
  `/${META_GRAPH_VERSION}/${wabaId}/${edge}`;
const objectEndpoint = (id: string, label: string) =>
  `/${META_GRAPH_VERSION}/${metaId(id, label)}`;

/* ---------------------------------- shapes --------------------------------- */

const CHANNELS = ["whatsapp", "telegram", "slack", "email", "sms", "linkedin", "other"] as const;

/**
 * Channels that speak as a person's own account, not as a business line.
 *
 * LinkedIn messages are read and sent by the org's agent in its own signed-in
 * browser — there is no messaging API for a member account — and an account
 * that messages people who never answer is exactly what LinkedIn restricts. So:
 *
 * - every message is written by a signed-in person here, never by the agent;
 * - a thread takes ONE opening message, then nothing more until the contact
 *   writes back (a failed send does not count, so it can be retried);
 * - the agent sends an opening message only to a 1st-degree connection and
 *   fails it otherwise. The app cannot see someone's connections, so that
 *   check lives with the agent (agent.md); outbox items flag `opening`.
 */
const CONNECTION_CHANNELS = new Set<string>(["linkedin"]);

/**
 * A LinkedIn member's one stable address: their public profile URL.
 *
 *   "linkedin.com/in/Jane-Doe/"             → "https://www.linkedin.com/in/jane-doe"
 *   "https://nl.linkedin.com/in/jane-doe?x" → "https://www.linkedin.com/in/jane-doe"
 *   "https://www.linkedin.com/sales/lead/…" → null   only opens for a signed-in seat
 *
 * Returns null for anything that is not a /in/ profile, so a thread can never
 * be keyed on a link that changes with whoever is looking at it.
 */
function linkedinProfile(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const m = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  slug = slug.trim().toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

/** Channels whose handle is a phone number, and so has one canonical spelling. */
const PHONE_CHANNELS = new Set<string>(["whatsapp", "sms"]);

/**
 * The one true spelling of a contact's handle.
 *
 * Contacts are found by exact string match, so the same person arriving by two
 * routes has to produce the same string or they become two contacts with two
 * threads — and then a human opening "the thread" sees only half of what was
 * said, which is exactly what this inbox exists to prevent. The two routes
 * disagree by default: a provider webhook reports `+447428690456` while another
 * app hands over whatever it happens to store, e.g. `447428690456`.
 *
 * This only ever reshapes what is already present. It never guesses a country
 * code, because guessing one messages a stranger:
 *
 *   "+44 7428 690456" → "+447428690456"   punctuation and spaces dropped
 *   "447428690456"    → "+447428690456"   the leading + providers omit
 *   "00447428690456"  → "+447428690456"   international access code
 *   "0640576368"      → null              national format — country unknowable
 *
 * Returns null when no canonical form can be derived without inventing data.
 */
function canonicalHandle(channel: string, handle: string): string | null {
  const raw = handle.trim();
  if (!raw) return null;
  if (channel === "email") return raw.toLowerCase();
  if (channel === "linkedin") return linkedinProfile(raw);
  if (!PHONE_CHANNELS.has(channel)) return raw;

  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  // "00" is the international access code — the written form of "+".
  if (digits.startsWith("00")) digits = digits.slice(2);
  // A single leading 0 is a national trunk prefix. Which country it belongs to
  // is not recoverable from the number, so refuse rather than assume.
  if (digits.startsWith("0")) return null;
  // Shortest real E.164 is 8 digits (country code + subscriber); longest is 15.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

const ContactSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    handle: z.string(),
    /** Curated label, set by a human. Null unless someone chose one. */
    name: z.string().nullable(),
    /** The contact's own channel profile name, refreshed from inbound. */
    profileName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  })
  .openapi("Contact");

const SendWindowSchema = z
  .object({
    freeformAllowed: z.boolean(),
    expiresAt: z.string().nullable(),
    lastInboundAt: z.string().nullable(),
  })
  .openapi("SendWindow");

const ConversationSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    subject: z.string().nullable(),
    status: z.string(),
    unread: z.number(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    contact: ContactSchema,
    /**
     * The last real message in this thread is an outbound the channel did not
     * deliver (status failed or undelivered). Rendered as a red chip; the
     * transition to that state also flips the thread unread, so it asks for a
     * human once and then files back into recency order — a permanently pinned
     * failure from three weeks ago buries today's live conversations.
     */
    undelivered: z.boolean(),
    /** The dashboard user who owns the thread; null means unassigned. */
    assignee: z
      .object({ id: z.string(), name: z.string().nullable() })
      .nullable()
      .openapi("Assignee"),
    /** True when the thread's last message is older than the stale horizon. */
    stale: z.boolean(),
    /** What this thread accepts right now — freeform, or template-only. */
    window: SendWindowSchema,
  })
  .openapi("Conversation");

const TemplateSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    name: z.string(),
    language: z.string(),
    category: z.string(),
    status: z.string(),
    bodyText: z.string(),
    variables: z.array(z.string()),
    /** The provider's own component array (header/body/footer/buttons). The
     *  editor needs it to show what it is NOT editing, and callers building an
     *  edit need to see the shape they are preserving. */
    components: z.array(z.unknown()),
    syncedAt: z.string(),
  })
  .openapi("Template");

const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    kind: z.string(),
    body: z.string(),
    authorName: z.string().nullable(),
    status: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    /** Set when this outbound message was sent as an approved template. */
    templateName: z.string().nullable(),
    /** Channel reference to an attachment, when the message carried one. */
    mediaRef: z.string().nullable(),
    /** image | audio | video | document. */
    mediaType: z.string().nullable(),
    /** Set once the attachment's bytes live in the app's own storage. */
    mediaKey: z.string().nullable(),
    /** MIME type of the stored bytes. */
    mediaMime: z.string().nullable(),
    /** Original filename the channel supplied, when any. */
    mediaName: z.string().nullable(),
  })
  .openapi("Message");

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const jsonBody = <T extends z.ZodTypeAny>(s: T) => ({
  content: { "application/json": { schema: s } },
});
const jsonRes = <T extends z.ZodTypeAny>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

/* --------------------------------- media ---------------------------------- */

/**
 * The storage prefixes this app serves under `/api/media/`. Both are opaque,
 * unguessable keys (`media/<org>/<messageId>`, `att/<uuid>`), and the serve
 * route accepts nothing else — the route is public so Meta can fetch outbound
 * attachment links, which makes the prefix allowlist the only thing between a
 * brute-forced-looking URL and the rest of the bucket.
 */
const MEDIA_PREFIX = /^(media|att)\//;

/** Uploads above this are left with their ref for a manual fetch instead. */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** MIME type → the WhatsApp message type a send takes. */
const mimeToKind = (mime: string | null): "image" | "video" | "audio" | "document" => {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
};

/**
 * Fetch an inbound attachment's bytes and keep them.
 *
 * Two reference shapes arrive (see the ingest media field): Meta's
 * `whatsapp-media:<id>`, which must be exchanged for a short-lived download
 * URL, and a plain `https://` link the provider already serves. Returns null
 * when nothing was stored — storage not on this deployment, a ref shape this
 * code does not know, or a fetch that failed — and the caller keeps the ref,
 * which is backfillable while the provider still hosts the file.
 */
async function storeMedia(
  env: Env["Bindings"],
  org: string,
  messageId: string,
  mediaRef: string,
): Promise<{ key: string; mime: string | null; name: string | null } | null> {
  if (typeof env.UPLOADS?.put !== "function") return null;

  let url: string | null = null;
  let mime: string | null = null;
  let name: string | null = null;
  let token: string | null = null;

  if (mediaRef.startsWith("whatsapp-media:")) {
    const id = mediaRef.slice("whatsapp-media:".length).trim();
    if (!/^\d+$/.test(id)) return null;
    // Meta describes the media (url, mime_type, filename) and hosts the bytes
    // behind an Authorization header — the client's raw token is the only way
    // to follow the URL it hands back.
    const { client } = whatsappBusiness(env);
    token = await (client as unknown as { token(): Promise<string | null> }).token();
    if (!token) return null;
    const described = await client.get(objectEndpoint(id, "media ID"));
    const row = unwrapMetaRows(described).rows[0] ?? (described as Record<string, unknown>);
    const u = row.url;
    if (typeof u !== "string") return null;
    url = u;
    if (typeof row.mime_type === "string") mime = row.mime_type;
    if (typeof row.filename === "string") name = row.filename;
  } else if (/^https:\/\//i.test(mediaRef)) {
    url = mediaRef;
  } else {
    return null;
  }

  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) return null;
  mime ??= res.headers.get("content-type");

  const key = `media/${org}/${messageId}`;
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: mime ? { contentType: mime } : undefined,
    customMetadata: name ? { name } : undefined,
  });
  return { key, mime: mime ?? null, name };
}

/**
 * Serve one stored attachment. Public by manifest (`api.public_routes`) because
 * Meta fetches outbound attachment links from outside the perimeter, and both
 * prefixes carry unguessable ids — the URL IS the capability, the same posture
 * as every signed download link. Anything not under an allowed prefix 404s.
 */
// Registered outside the OpenAPI builder on purpose: the response is a raw
// byte stream, not JSON, and the typed-route machinery only speaks JSON.
api.get("/api/media/:key{.+}", async (c) => {
  const { key } = c.req.param();
  const env = c.env;
  if (!MEDIA_PREFIX.test(key) || typeof env.UPLOADS?.get !== "function") {
    return c.json({ error: "no such attachment" }, 404);
  }
  const obj = await env.UPLOADS.get(key);
  if (!obj) return c.json({ error: "no such attachment" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Uploaded HTML/SVG must not execute with the app's origin privileges.
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  const name = obj.customMetadata?.name;
  if (name) headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  return new Response(obj.body, { headers, status: 200 });
});

/**
 * A human or the composer uploads a file to send later. The key is returned
 * with a public URL the outbound sender can hand to Meta.
 */
api.openapi(
  createRoute({
    method: "post",
    path: "/api/uploads",
    summary: "Store an attachment to send",
    description:
      "Raw binary body (the file itself, not multipart) with the MIME type in Content-Type and an optional ?filename=. Stores it and returns a public URL usable both for display and as the link an outbound attachment is sent by. Empty or oversized bodies are rejected here, not at send time.",
    request: {
      query: z.object({ filename: z.string().optional() }),
      // The body is the file itself — declared unconstrained because OpenAPI
      // binary bodies are typed as strings otherwise.
      body: { content: { "*/*": { schema: z.string() } } },
    },
    responses: {
      201: jsonRes(
        z.object({ key: z.string(), url: z.string(), mime: z.string().nullable() }).openapi("Upload"),
        "Stored — use url in a reply attachment",
      ),
      400: jsonRes(ErrorSchema, "Empty body"),
      401: jsonRes(ErrorSchema, "No org identity"),
      413: jsonRes(ErrorSchema, "File too large"),
      500: jsonRes(ErrorSchema, "Storage is not available on this deployment"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const env = c.env;
    if (typeof env.UPLOADS?.put !== "function") {
      return c.json(
        { error: "storage is not available on this deployment — redeploy with app.storage enabled" },
        500,
      );
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return c.json({ error: "empty upload" }, 400);
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      return c.json({ error: `files up to ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB are accepted` }, 413);
    }
    const mime = c.req.header("content-type")?.split(";")[0]?.trim() || null;
    const key = `att/${crypto.randomUUID()}`;
    const filename = c.req.valid("query").filename;
    await env.UPLOADS.put(key, bytes, {
      httpMetadata: mime ? { contentType: mime } : undefined,
      customMetadata: filename ? { name: filename } : undefined,
    });
    return c.json({ key, url: `${new URL(c.req.url).origin}/api/media/${key}`, mime: mime ?? null }, 201);
  },
);

/* ------------------------- the re-engagement window ------------------------ */

/**
 * WhatsApp Business only accepts freeform messages inside a 24-hour customer
 * service window that opens on each *inbound* message. Outside it — and on a
 * contact who has never written — the only way through is a template Meta has
 * approved. Everything below encodes that one rule.
 *
 * The window is measured from the last INBOUND message, not the last message:
 * a thread we replied to an hour ago is still closed if the contact last wrote
 * three days back.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Channels that have a re-engagement window. Others take freeform any time. */
const WINDOWED_CHANNELS = new Set(["whatsapp"]);

type SendWindow = {
  /** False when only an approved template may be sent. */
  freeformAllowed: boolean;
  /** ISO time the window shuts; null when the channel has none or it's shut. */
  expiresAt: string | null;
  lastInboundAt: string | null;
};

const OPEN_WINDOW: SendWindow = {
  freeformAllowed: true,
  expiresAt: null,
  lastInboundAt: null,
};

/**
 * Connection channels: open for one opening message, then shut until the
 * contact writes; once they have, open for good.
 */
const connectionWindow = (lastInboundAt: string | null, openingUsed: boolean): SendWindow => ({
  freeformAllowed: lastInboundAt !== null || !openingUsed,
  expiresAt: null,
  lastInboundAt,
});

const windowFrom = (lastInboundAt: string | null, now: number): SendWindow => {
  if (!lastInboundAt) return { freeformAllowed: false, expiresAt: null, lastInboundAt: null };
  const closesAt = new Date(lastInboundAt).getTime() + WINDOW_MS;
  const open = closesAt > now;
  return {
    freeformAllowed: open,
    expiresAt: open ? new Date(closesAt).toISOString() : null,
    lastInboundAt,
  };
};

/**
 * Window state for a page of conversations in ONE aggregate query — the list
 * renders it per row, so a per-row lookup would be an N+1 on every poll.
 */
async function windowsFor(
  db: DB,
  convs: (typeof schema.conversations.$inferSelect)[],
  now = Date.now(),
): Promise<Map<string, SendWindow>> {
  const gated = (c: { channel: string }) =>
    WINDOWED_CHANNELS.has(c.channel) || CONNECTION_CHANNELS.has(c.channel);
  const windowed = convs.filter(gated);
  const out = new Map<string, SendWindow>(
    convs.filter((c) => !gated(c)).map((c) => [c.id, OPEN_WINDOW]),
  );
  if (windowed.length === 0) return out;

  // D1 allows at most 100 bound parameters per statement, and `kind` already
  // takes one — a full page of 100 conversations binds 101 and the query
  // fails. Page the id list under the cap and merge.
  const CHUNK = 80;
  const lastInbound: { conversationId: string; at: string }[] = [];
  for (let i = 0; i < windowed.length; i += CHUNK) {
    lastInbound.push(
      ...(await db
        .select({
          conversationId: schema.messages.conversationId,
          at: sql<string>`max(${schema.messages.createdAt})`,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.kind, "inbound"),
            inArray(
              schema.messages.conversationId,
              windowed.slice(i, i + CHUNK).map((c) => c.id),
            ),
          ),
        )
        .groupBy(schema.messages.conversationId)),
    );
  }

  // Connection channels also need to know whether an opening message already
  // went out (or is waiting to): anything outbound that did not fail. Our own
  // earlier messages mirrored in by the agent count too.
  const connection = windowed.filter((c) => CONNECTION_CHANNELS.has(c.channel));
  const opened = new Set<string>();
  for (let i = 0; i < connection.length; i += CHUNK) {
    const rows = await db
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.kind, "outbound"),
          sql`coalesce(${schema.messages.status}, '') <> 'failed'`,
          inArray(
            schema.messages.conversationId,
            connection.slice(i, i + CHUNK).map((c) => c.id),
          ),
        ),
      )
      .groupBy(schema.messages.conversationId);
    for (const r of rows) opened.add(r.conversationId);
  }

  const byConv = new Map(lastInbound.map((r) => [r.conversationId, r.at]));
  for (const c of windowed) {
    const last = byConv.get(c.id) ?? null;
    out.set(
      c.id,
      CONNECTION_CHANNELS.has(c.channel) ? connectionWindow(last, opened.has(c.id)) : windowFrom(last, now),
    );
  }
  return out;
}

/** Window state for a single conversation. */
async function sendWindow(
  db: DB,
  conv: typeof schema.conversations.$inferSelect,
  now = Date.now(),
): Promise<SendWindow> {
  return (await windowsFor(db, [conv], now)).get(conv.id) ?? OPEN_WINDOW;
}

/* --------------------------------- templates ------------------------------- */

/** Placeholder tokens in a template body, in order: {{1}} / {{first_name}}. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const placeholdersIn = (body: string): string[] => {
  const seen = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER)) seen.add(m[1]);
  return [...seen];
};

/** Substitutes values into a template body for the human-readable timeline. */
const renderTemplate = (body: string, values: Record<string, string>) =>
  body.replace(PLACEHOLDER, (whole, token: string) => values[token] ?? whole);

/** Pulls the BODY component's text out of Meta's components array. */
function bodyTextOf(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const c of components) {
    if (c && typeof c === "object" && (c as { type?: string }).type?.toUpperCase() === "BODY") {
      return String((c as { text?: string }).text ?? "");
    }
  }
  return "";
}

/** One template as the provider describes it, before it becomes a row. */
type ProviderTemplate = {
  name: string;
  language: string;
  category?: string;
  status?: string;
  components?: unknown;
  id?: string;
};

/**
 * Where a channel's catalogue comes from. The app fetches this itself through
 * the org's connected integration (`@clawnify/connections`) rather than waiting
 * for an agent to mirror it in: the catalogue is reference data, needs no
 * judgement, and a human clicking "Refresh" should get an answer now.
 *
 * Only channels with a real template concept appear here — everything else
 * takes freeform and has nothing to list.
 */
/**
 * Composio caps `limit` at 100, but a full page is slow enough that the broker
 * hop times out (522). Smaller pages return inside the budget; pagination below
 * still walks the whole catalogue, so this costs round trips, not coverage.
 */
const PROVIDER_PAGE = 25;
/** Backstop so a paging bug can't spin forever: 25 × 40 = 1000 templates. */
const MAX_PAGES = 40;

const TEMPLATE_SOURCES: Record<string, (env: Env["Bindings"]) => Promise<ProviderTemplate[]>> = {
  whatsapp: async (env) => {
    // Every status, not just APPROVED. The picker is already APPROVED-only (the
    // list endpoint defaults to it), so filtering here as well bought nothing
    // and cost the one thing people need to see: editing an approved template
    // sends it back into review at Meta, and a catalogue of APPROVED-only made
    // it VANISH — indistinguishable from deleted, with nothing to tell anyone
    // it is coming back. Sync the lot; let the reader decide what to show.
    const { client, wabaId } = whatsappBusiness(env);
    const all: ProviderTemplate[] = [];
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.get(wabaEndpoint(wabaId, "message_templates"), {
        query: {
          limit: PROVIDER_PAGE,
          ...(after ? { after } : {}),
        },
      });
      const { items, nextCursor } = metaPage(result);
      all.push(...items);
      if (!nextCursor || items.length === 0) break;
      after = nextCursor;
    }
    return all;
  },
};

/**
 * Pull one page out of Meta's `{ data: [...], paging: { cursors: { after } } }`,
 * however deep the broker nests it under its own `data` envelope. Written
 * defensively on purpose: the shape belongs to two vendors, and a silent change
 * should yield an empty catalogue, never a crash.
 */
/**
 * Descend through the broker's `data` envelopes to Meta's own
 * `{ data: [...], paging }` node. Shared by every Meta reader here, and written
 * defensively: the shape belongs to two vendors, so an unexpected one should
 * yield nothing rather than throw.
 */
function unwrapMetaRows(result: unknown): {
  rows: Record<string, unknown>[];
  paging?: { cursors?: { after?: string }; next?: string };
} {
  const seen = new Set<unknown>();
  let node: unknown = result;
  let holder: Record<string, unknown> | undefined;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      holder = obj;
      break;
    }
    node = obj.data;
  }
  const raw = Array.isArray(holder?.data) ? holder.data : Array.isArray(result) ? result : [];
  return {
    rows: raw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object"),
    paging: holder?.paging as { cursors?: { after?: string }; next?: string } | undefined,
  };
}

function metaPage(result: unknown): { items: ProviderTemplate[]; nextCursor?: string } {
  const { rows, paging } = unwrapMetaRows(result);
  // No `next` link means this is the last page, whatever the cursor says.
  const nextCursor = paging?.next ? paging.cursors?.after : undefined;

  const items = rows
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .filter((t) => typeof t.name === "string" && typeof t.language === "string")
    .map((t) => ({
      name: t.name as string,
      language: t.language as string,
      category: typeof t.category === "string" ? t.category : undefined,
      status: typeof t.status === "string" ? t.status : undefined,
      components: t.components,
      id: typeof t.id === "string" ? t.id : undefined,
    }));

  return { items, nextCursor };
}

/**
 * Replace a channel's catalogue in one shot. A replace (not a merge) is what
 * keeps a paused or deleted template from lingering in the composer after the
 * provider has withdrawn it.
 */
async function replaceCatalogue(
  db: DB,
  org: string,
  channel: string,
  templates: ProviderTemplate[],
): Promise<number> {
  const now = new Date().toISOString();
  await db
    .delete(schema.templates)
    .where(and(eq(schema.templates.orgId, org), eq(schema.templates.channel, channel)));

  if (templates.length === 0) return 0;

  const rows = templates.map((t) => {
    const bodyText = bodyTextOf(t.components);
    return {
      orgId: org,
      channel,
      name: t.name,
      language: t.language,
      category: t.category ?? "UTILITY",
      // Never default to APPROVED: the catalogue now carries every status, and
      // a provider that omits one must not get a free pass into the picker.
      status: (t.status ?? "UNKNOWN").toUpperCase(),
      bodyText,
      variables: JSON.stringify(placeholdersIn(bodyText)),
      components: JSON.stringify(t.components ?? []),
      externalId: t.id ?? null,
      syncedAt: now,
    };
  });

  // Chunked: each row binds 12 parameters, and D1 caps bound parameters per
  // statement — one INSERT of a whole catalogue blows that limit.
  const ROWS_PER_INSERT = 5;
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    await db.insert(schema.templates).values(rows.slice(i, i + ROWS_PER_INSERT));
  }
  return rows.length;
}

const toContact = (contact: typeof schema.contacts.$inferSelect) => ({
  id: contact.id,
  channel: contact.channel,
  handle: contact.handle,
  name: contact.name,
  profileName: contact.profileName,
  avatarUrl: contact.avatarUrl,
  // The link only — never the linked record. Resolving every contact's profile
  // to render a list would be one proxy call per row; the client asks for a
  // profile when it actually shows one.
  linked: contact.linkedAppId && contact.linkedRef
    ? { appId: contact.linkedAppId, ref: contact.linkedRef }
    : null,
});

/**
 * A thread that has not moved in this long is flagged stale in the list. Not a
 * deadline the server enforces — a nudge rendered where a human decides.
 */
const STALE_MS = 24 * 60 * 60 * 1000;

const toConversation = (
  conv: typeof schema.conversations.$inferSelect,
  contact: typeof schema.contacts.$inferSelect,
  window: SendWindow,
  undelivered = false,
) => ({
  id: conv.id,
  channel: conv.channel,
  subject: conv.subject,
  status: conv.status,
  unread: conv.unread,
  lastMessageAt: conv.lastMessageAt,
  lastMessagePreview: conv.lastMessagePreview,
  contact: toContact(contact),
  undelivered,
  assignee:
    conv.assigneeId && conv.assigneeId !== "assignee_id"
      ? { id: conv.assigneeId, name: conv.assigneeName }
      : null,
  stale: Date.now() - new Date(conv.lastMessageAt).getTime() > STALE_MS,
  window,
});

const toMessage = (m: typeof schema.messages.$inferSelect) => ({
  id: m.id,
  conversationId: m.conversationId,
  kind: m.kind,
  body: m.body,
  authorName: m.authorName,
  status: m.status,
  error: m.error,
  createdAt: m.createdAt,
  templateName: m.templateName,
  // Guarded because SQLite returns a double-quoted identifier as a STRING
  // LITERAL when the column does not exist, so a missing migration silently
  // hands every row the column's own name instead of failing. Anything that
  // equals the column name is that bug, not data.
  mediaRef: m.mediaRef && m.mediaRef !== "media_ref" ? m.mediaRef : null,
  mediaType: m.mediaType && m.mediaType !== "media_type" ? m.mediaType : null,
  mediaKey: m.mediaKey && m.mediaKey !== "media_key" ? m.mediaKey : null,
  mediaMime: m.mediaMime && m.mediaMime !== "media_mime" ? m.mediaMime : null,
  mediaName: m.mediaName && m.mediaName !== "media_name" ? m.mediaName : null,
});

const toTemplate = (t: typeof schema.templates.$inferSelect) => ({
  id: t.id,
  channel: t.channel,
  name: t.name,
  language: t.language,
  category: t.category,
  status: t.status,
  bodyText: t.bodyText,
  variables: JSON.parse(t.variables) as string[],
  components: ((): unknown[] => {
    try {
      const p = JSON.parse(t.components) as unknown;
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  })(),
  syncedAt: t.syncedAt,
});

/** Loads a conversation scoped to the caller's org; null means 404 or no org. */
async function findConversation(
  c: { env: Env["Bindings"]; req: { header(name: string): string | undefined } },
  id: string,
) {
  const org = orgId(c);
  if (!org) return null;
  const db = dbFor(c.env);
  const [row] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.orgId, org), eq(schema.conversations.id, id)))
    .limit(1);
  return row ?? null;
}

/* ---------------------------------- ingest --------------------------------- */

const IngestSchema = z
  .object({
    channel: z.enum(CHANNELS),
    contact: z.object({
      handle: z.string().min(1),
      name: z.string().optional(),
      avatarUrl: z.string().url().optional(),
      /**
       * The person this handle belongs to in the org's system of record. Set it
       * when you already know — you looked the number up to answer the message
       * anyway. Never guessed: a wrong link is worse than none.
       */
      linked: z.object({ appId: z.string().min(1), ref: z.string().min(1) }).optional(),
    }),
    message: z.object({
      kind: z.enum(["inbound", "outbound"]).default("inbound"),
      // Not .min(1): a photo sent with no caption has an empty body and is
      // still a message. Requiring text rejected those outright.
      body: z.string(),
      externalId: z.string().optional(),
      at: z.string().datetime().optional(),
      authorName: z.string().optional(),
      /**
       * A picture, voice note or document on this message. `ref` is how the
       * channel names it — Meta sends `whatsapp-media:<id>` to exchange for a
       * short-lived URL, Bird sends a plain URL — so it is a reference to
       * resolve later, not a link to render.
       */
      // Tolerant on the way in: a flow renders these through a template, so an
      // absent attachment arrives as empty strings rather than being omitted.
      // An empty ref means no attachment.
      media: z.object({
        ref: z.string(),
        type: z.string().optional(),
      }).optional(),
    }),
    subject: z.string().optional(),
  })
  .openapi("Ingest");

api.openapi(
  createRoute({
    method: "post",
    path: "/api/ingest",
    summary: "Ingest a channel message (agent only)",
    description:
      "Mirror one inbound or outbound channel message into the inbox. Creates the contact and conversation on first sight, reopens closed conversations on new inbound, and is idempotent on message.externalId. Use kind=outbound for messages the agent already sent itself (history sync).",
    request: { body: jsonBody(IngestSchema) },
    responses: {
      200: jsonRes(
        z
          .object({ conversationId: z.string(), messageId: z.string().nullable(), duplicate: z.boolean() })
          .openapi("IngestResult"),
        "Ingest result",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      403: jsonRes(ErrorSchema, "Caller may not ingest"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const who = caller(c);
    if (who !== "agent" && who !== "api" && who !== "system") {
      return c.json({ error: "only the agent may ingest messages" }, 403);
    }

    const input = c.req.valid("json");
    const db = dbFor(c.env);
    const now = new Date().toISOString();
    const at = input.message.at ?? now;

    // Best-effort here, never rejected: this is a message that already reached
    // us, and dropping a real inbound because its handle is oddly shaped loses
    // something a person actually said. An un-canonicalisable handle is stored
    // as given — worse for matching, but nothing is lost.
    const handle = canonicalHandle(input.channel, input.contact.handle) ?? input.contact.handle;

    // Contact: find or create; refresh name/avatar when provided.
    let [contact] = await db
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.orgId, org),
          eq(schema.contacts.channel, input.channel),
          eq(schema.contacts.handle, handle),
        ),
      )
      .limit(1);
    if (!contact) {
      [contact] = await db
        .insert(schema.contacts)
        .values({
          orgId: org,
          channel: input.channel,
          handle,
          // Provider-supplied → profileName. `name` is the human's to set.
          profileName: input.contact.name ?? null,
          avatarUrl: input.contact.avatarUrl ?? null,
          linkedAppId: input.contact.linked?.appId ?? null,
          linkedRef: input.contact.linked?.ref ?? null,
        })
        .returning();
    } else if (
      (input.contact.name && input.contact.name !== contact.profileName) ||
      (input.contact.avatarUrl && input.contact.avatarUrl !== contact.avatarUrl) ||
      (input.contact.linked && input.contact.linked.ref !== contact.linkedRef)
    ) {
      [contact] = await db
        .update(schema.contacts)
        .set({
          // Only the profile name — a curated `name` outlives every inbound.
          profileName: input.contact.name ?? contact.profileName,
          avatarUrl: input.contact.avatarUrl ?? contact.avatarUrl,
          // An existing link is never cleared by an ingest that omits one:
          // absence here means "didn't look it up", not "no longer linked".
          linkedAppId: input.contact.linked?.appId ?? contact.linkedAppId,
          linkedRef: input.contact.linked?.ref ?? contact.linkedRef,
        })
        .where(eq(schema.contacts.id, contact.id))
        .returning();
    }

    // Conversation: one per contact; new inbound reopens a closed thread.
    let [conv] = await db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.orgId, org), eq(schema.conversations.contactId, contact.id)))
      .limit(1);
    if (!conv) {
      [conv] = await db
        .insert(schema.conversations)
        .values({
          orgId: org,
          contactId: contact.id,
          channel: input.channel,
          subject: input.subject ?? null,
          lastMessageAt: at,
          lastMessagePreview: preview(input.message.body),
        })
        .returning();
    }

    // Idempotency: same externalId → acknowledge without inserting.
    if (input.message.externalId) {
      const [dupe] = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.orgId, org), eq(schema.messages.externalId, input.message.externalId)),
        )
        .limit(1);
      if (dupe) return c.json({ conversationId: conv.id, messageId: dupe.id, duplicate: true }, 200);
    }

    const inbound = input.message.kind === "inbound";
    const mediaRef = input.message.media?.ref?.trim() || null;
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: org,
        conversationId: conv.id,
        kind: input.message.kind,
        body: input.message.body,
        authorName: input.message.authorName ?? (inbound ? contact.name ?? contact.handle : "Agent"),
        status: inbound ? null : "sent",
        externalId: input.message.externalId ?? null,
        mediaRef,
        mediaType: (mediaRef && input.message.media?.type?.trim()) || null,
        createdAt: at,
      })
      .returning();

    // Keep the attachment's bytes now, while the channel still serves them:
    // both reference shapes expire, and "we'll fetch it later" loses the file.
    // Best-effort — a failed fetch leaves mediaRef in place (backfillable) and
    // the timeline falls back to the filename, which is why the helper never
    // throws.
    if (mediaRef) {
      try {
        const stored = await storeMedia(c.env, org, msg.id, mediaRef);
        if (stored) {
          await db
            .update(schema.messages)
            .set({ mediaKey: stored.key, mediaMime: stored.mime, mediaName: stored.name })
            .where(eq(schema.messages.id, msg.id));
        }
      } catch {
        // Swallowed on purpose: the message arrived; losing its bytes is a
        // degraded timeline, not a failed ingest.
      }
    }

    await db
      .update(schema.conversations)
      .set({
        subject: input.subject ?? conv.subject,
        // History backfill can arrive out of order — only advance the clock.
        ...(at >= conv.lastMessageAt
          ? {
              lastMessageAt: at,
              lastMessagePreview: preview(
                input.message.body ||
                  (input.message.media?.ref?.trim()
                    ? `[${input.message.media.type?.trim() || "attachment"}]`
                    : ""),
              ),
            }
          : {}),
        ...(inbound ? { unread: 1, status: "open" } : {}),
      })
      .where(eq(schema.conversations.id, conv.id));

    return c.json({ conversationId: conv.id, messageId: msg.id, duplicate: false }, 200);
  },
);

/* ------------------------------- conversations ----------------------------- */

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations",
    summary: "List conversations",
    description:
      "Paginated inbox, most recent first. Filter by channel and status (default open); search matches contact name/handle and the last message preview.",
    request: {
      query: z.object({
        channel: z.enum(CHANNELS).optional(),
        status: z.enum(["open", "closed", "all"]).default("open"),
        search: z.string().optional(),
        /** "me" → assigned to the caller; "unassigned" → nobody owns it. */
        assignee: z.enum(["me", "unassigned"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(ConversationSchema), total: z.number() }).openapi("ConversationPage"),
        "One page of conversations",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [eq(schema.conversations.orgId, org)];
    if (q.channel) filters.push(eq(schema.conversations.channel, q.channel));
    if (q.status !== "all") filters.push(eq(schema.conversations.status, q.status));
    if (q.assignee === "me") {
      const u = user(c);
      if (!u) return c.json({ error: "no identity — cannot filter by assignee" }, 401);
      filters.push(eq(schema.conversations.assigneeId, u.id));
    } else if (q.assignee === "unassigned") {
      filters.push(isNull(schema.conversations.assigneeId));
    }
    if (q.search) {
      const term = `%${q.search}%`;
      filters.push(
        or(
          like(schema.contacts.name, term),
          like(schema.contacts.handle, term),
          like(schema.conversations.lastMessagePreview, term),
        )!,
      );
    }
    const where = and(...filters);

    // The last message the CONTACT's timeline saw — outbound or inbound only,
    // because a system audit line or an internal note written after a failed
    // send would otherwise hide the failure. The flag renders as a chip and the
    // failure transition marks the thread unread; the list itself stays in
    // recency order.
    const lastUndelivered = sql<number>`(
      SELECT CASE WHEN m.kind = 'outbound' AND m.status IN ('failed','undelivered') THEN 1 ELSE 0 END
      FROM messages m
      WHERE m.conversation_id = ${schema.conversations.id}
        AND m.kind IN ('inbound','outbound')
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    )`;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ conv: schema.conversations, contact: schema.contacts, undelivered: lastUndelivered })
        .from(schema.conversations)
        .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
        .where(where)
        .orderBy(desc(schema.conversations.lastMessageAt))
        .limit(q.limit)
        .offset(q.offset),
      db
        .select({ total: count() })
        .from(schema.conversations)
        .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
        .where(where),
    ]);

    const windows = await windowsFor(
      db,
      rows.map((r) => r.conv),
    );
    return c.json(
      {
        items: rows.map((r) =>
          toConversation(r.conv, r.contact, windows.get(r.conv.id) ?? OPEN_WINDOW, r.undelivered === 1),
        ),
        total,
      },
      200,
    );
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/search",
    summary: "Full-history search across every thread",
    description:
      "Substring match (case-insensitive, LIKE with escaped wildcards) over the bodies of real messages — inbound, outbound and internal notes — in the org. Returns the matching messages with enough conversation context to jump into the thread. Ordered newest first.",
    request: {
      query: z.object({
        q: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    },
    responses: {
      200: jsonRes(
        z
          .object({
            items: z.array(
              z
                .object({
                  messageId: z.string(),
                  conversationId: z.string(),
                  kind: z.string(),
                  body: z.string(),
                  authorName: z.string().nullable(),
                  createdAt: z.string(),
                  contact: ContactSchema,
                })
                .openapi("SearchHit"),
            ),
          })
          .openapi("SearchResult"),
        "Messages matching the query",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { q, limit } = c.req.valid("query");

    // Escape LIKE's own wildcards so a search for "50%off" finds "50% off",
    // not "50x off" — and declare ESCAPE so the backslash means that.
    const term = "%" + q.replace(/[\\%_]/g, (ch) => `\\${ch}`) + "%";
    const rows = await dbFor(c.env)
      .select({ msg: schema.messages, contact: schema.contacts })
      .from(schema.messages)
      .innerJoin(
        schema.conversations,
        and(
          eq(schema.messages.conversationId, schema.conversations.id),
          eq(schema.conversations.orgId, org),
        ),
      )
      .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
      .where(
        and(
          inArray(schema.messages.kind, ["inbound", "outbound", "comment"]),
          sql`lower(${schema.messages.body}) LIKE lower(${term}) ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(limit);

    return c.json(
      {
        items: rows.map((r) => ({
          messageId: r.msg.id,
          conversationId: r.msg.conversationId,
          kind: r.msg.kind,
          body: r.msg.body,
          authorName: r.msg.authorName,
          createdAt: r.msg.createdAt,
          contact: toContact(r.contact),
        })),
      },
      200,
    );
  },
);

const ProfileSchema = z
  .object({
    ref: z.string().nullable(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    profileUrl: z.string().nullable(),
  })
  .openapi("Profile");

const ProfileSourceSchema = z
  .object({
    appId: z.string().min(1),
    label: z.string().optional(),
    search: z.object({
      path: z.string().min(1),
      query: z.string().min(1),
      collection: z.string().optional(),
    }),
    get: z.object({ path: z.string().min(1), collection: z.string().optional() }).optional(),
    fields: z.object({
      ref: z.string().min(1),
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
    }),
    profileUrl: z.string().optional(),
  })
  .openapi("ProfileSource");

api.openapi(
  createRoute({
    method: "get",
    path: "/api/profile-source",
    summary: "The org's configured system of record for people",
    description:
      "Which sibling app this inbox looks people up in, and how its fields map. Null when nothing is configured — the inbox works fine without it, contacts just show their handle.",
    responses: {
      200: jsonRes(
        z.object({ source: ProfileSourceSchema.nullable() }).openapi("ProfileSourceResult"),
        "Current configuration",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    return c.json({ source: await readProfileSource(dbFor(c.env), org, c.env) }, 200);
  },
);

api.openapi(
  createRoute({
    method: "put",
    path: "/api/profile-source",
    summary: "Point this inbox at the org's people app",
    description:
      "Set which sibling Clawnify app holds the org's people and how to read it. The agent can write this once after reading the target app's /api/openapi.json; a human can correct it. Verified against the live app before saving, so a wrong appId or path fails here rather than silently at search time.",
    request: { body: jsonBody(ProfileSourceSchema) },
    responses: {
      200: jsonRes(
        z.object({ ok: z.boolean(), sampled: z.number() }).openapi("ProfileSourceSaved"),
        "Saved and verified",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      422: jsonRes(ErrorSchema, "The target app did not answer as described"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const src = c.req.valid("json") as ProfileSource;

    // Prove the config before storing it. A search that returns rows without
    // the declared `ref` field is a mapping error, and finding that out now is
    // the difference between one clear 422 and a picker that is mysteriously
    // always empty.
    let sampled = 0;
    try {
      const sep = src.search.path.includes("?") ? "&" : "?";
      const body = await callSibling(
        c.env,
        src.appId,
        `${src.search.path}${sep}${encodeURIComponent(src.search.query)}=&limit=1`,
      );
      const rows = collectionOf(body, src.search.collection);
      sampled = rows.length;
      if (rows.length && !str(rows[0][src.fields.ref])) {
        return c.json(
          {
            error: `records from ${src.search.path} have no "${src.fields.ref}" field — fields.ref must name the record's id`,
          },
          422,
        );
      }
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }

    const now = new Date().toISOString();
    await dbFor(c.env)
      .insert(schema.settings)
      .values({ orgId: org, key: PROFILE_SOURCE_KEY, value: JSON.stringify(src), updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.settings.orgId, schema.settings.key],
        set: { value: JSON.stringify(src), updatedAt: now },
      });

    return c.json({ ok: true, sampled }, 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/profile-source/search",
    summary: "Search the org's people app",
    description:
      "Type-ahead over the configured system of record, so a human starting a conversation picks a known person instead of typing a phone number. Returns [] when no profile source is configured.",
    request: { query: z.object({ q: z.string().optional(), limit: z.string().optional() }) },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(ProfileSchema) }).openapi("ProfileSearchResult"),
        "Matching people",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      424: jsonRes(ErrorSchema, "The people app could not be reached"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const src = await readProfileSource(dbFor(c.env), org, c.env);
    if (!src) return c.json({ items: [] }, 200);

    const { q, limit } = c.req.valid("query");
    const n = Math.min(25, Math.max(1, Number(limit) || 10));
    const sep = src.search.path.includes("?") ? "&" : "?";
    const path = `${src.search.path}${sep}${encodeURIComponent(src.search.query)}=${encodeURIComponent(
      q ?? "",
    )}&limit=${n}`;

    try {
      const rows = collectionOf(await callSibling(c.env, src.appId, path), src.search.collection);
      // Drop records with no id — they cannot be linked to, so offering them
      // would produce a contact pointing at nothing.
      return c.json({ items: rows.map((r) => toProfile(r, src)).filter((p) => p.ref) }, 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 424);
    }
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/contacts/{id}/profile",
    summary: "Resolve one contact's linked person, live",
    description:
      "Reads the linked record from the org's people app on demand. Never cached here: the CRM owns the person, so a stale copy in the inbox would be a second source of truth. 409 when the contact is not linked.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonRes(ProfileSchema, "The linked person"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "No such contact"),
      409: jsonRes(ErrorSchema, "Contact is not linked, or no profile source configured"),
      424: jsonRes(ErrorSchema, "The people app could not be reached"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const db = dbFor(c.env);

    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, org), eq(schema.contacts.id, c.req.valid("param").id)))
      .limit(1);
    if (!contact) return c.json({ error: "no such contact" }, 404);
    if (!contact.linkedAppId || !contact.linkedRef) {
      return c.json({ error: "this contact is not linked to a person" }, 409);
    }

    const src = await readProfileSource(db, org, c.env);
    if (!src?.get) {
      return c.json({ error: "no profile source with a `get` path is configured" }, 409);
    }
    // The contact's own appId wins over the configured one: a contact linked
    // before the org repointed its profile source must still resolve.
    const path = src.get.path.replace("{ref}", encodeURIComponent(contact.linkedRef));
    try {
      const body = await callSibling(c.env, contact.linkedAppId, path);
      const row = src.get.collection
        ? ((body as Record<string, unknown>)[src.get.collection] as Record<string, unknown>)
        : (body as Record<string, unknown>);
      if (!row || typeof row !== "object") {
        return c.json({ error: "linked person not found in the people app" }, 424);
      }
      return c.json(toProfile(row, src), 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 424);
    }
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations",
    summary: "Start a conversation with a contact",
    description:
      "Opens (or returns) the thread for one contact on one channel so a human can write first. Idempotent: an existing thread for that (channel, handle) is returned as-is, never duplicated. Sending is a separate step — POST /api/conversations/:id/reply — and the returned `window` says whether that reply may be freeform or must be a template.\n\nLinkedIn: only a signed-in person may open a thread, the handle must be a profile URL, and the thread takes one opening message until the contact replies. The agent sends it only if the person is a 1st-degree connection.",
    request: {
      body: jsonBody(
        z
          .object({
            channel: z.enum(CHANNELS),
            handle: z.string().min(1),
            name: z.string().optional(),
            subject: z.string().optional(),
            /** Set when the human picked a known person rather than typing a handle. */
            linked: z.object({ appId: z.string().min(1), ref: z.string().min(1) }).optional(),
          })
          .openapi("StartConversation"),
      ),
    },
    responses: {
      200: jsonRes(ConversationSchema, "The conversation (existing or new)"),
      401: jsonRes(ErrorSchema, "No org identity"),
      403: jsonRes(ErrorSchema, "LinkedIn threads are started by a signed-in person, never by the agent"),
      422: jsonRes(ErrorSchema, "Handle has no canonical form — a phone number needs its country code"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const input = c.req.valid("json");
    const db = dbFor(c.env);
    const now = new Date().toISOString();

    if (CONNECTION_CHANNELS.has(input.channel)) {
      if (!user(c)) {
        return c.json({ error: "Only a person can start a LinkedIn conversation." }, 403);
      }
      if (!canonicalHandle(input.channel, input.handle)) {
        return c.json(
          {
            error: `"${input.handle}" is not a LinkedIn profile URL. Use the address of their profile, like https://www.linkedin.com/in/their-name.`,
          },
          422,
        );
      }
    }

    // Strict here, unlike ingest: opening a thread is the prelude to sending,
    // and a handle with no canonical form has no country code — the provider
    // would reject it anyway. Failing now names the bad record; failing later
    // leaves a dead thread that looks real to whoever opens it.
    const handle = canonicalHandle(input.channel, input.handle);
    if (!handle) {
      return c.json(
        {
          error: `"${input.handle}" is not a usable ${input.channel} handle. Phone numbers need a country code (e.g. +447428690456) — a national-format number like 0640576368 could belong to any country.`,
        },
        422,
      );
    }

    let [contact] = await db
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.orgId, org),
          eq(schema.contacts.channel, input.channel),
          eq(schema.contacts.handle, handle),
        ),
      )
      .limit(1);
    if (!contact) {
      [contact] = await db
        .insert(schema.contacts)
        .values({
          orgId: org,
          channel: input.channel,
          handle,
          name: input.name ?? null,
          linkedAppId: input.linked?.appId ?? null,
          linkedRef: input.linked?.ref ?? null,
        })
        .returning();
    } else if (
      (input.name && input.name !== contact.name) ||
      (input.linked && input.linked.ref !== contact.linkedRef)
    ) {
      [contact] = await db
        .update(schema.contacts)
        .set({
          name: input.name ?? contact.name,
          // Re-linking an existing contact is legitimate — a handle typed by
          // hand last week is the person you just picked from the CRM today.
          linkedAppId: input.linked?.appId ?? contact.linkedAppId,
          linkedRef: input.linked?.ref ?? contact.linkedRef,
        })
        .where(eq(schema.contacts.id, contact.id))
        .returning();
    }

    let [conv] = await db
      .select()
      .from(schema.conversations)
      .where(
        and(eq(schema.conversations.orgId, org), eq(schema.conversations.contactId, contact.id)),
      )
      .limit(1);
    if (!conv) {
      [conv] = await db
        .insert(schema.conversations)
        .values({
          orgId: org,
          contactId: contact.id,
          channel: input.channel,
          subject: input.subject ?? null,
          lastMessageAt: now,
        })
        .returning();
    } else if (conv.status === "closed") {
      // Writing to an archived thread reopens it, same as a new inbound would.
      [conv] = await db
        .update(schema.conversations)
        .set({ status: "open" })
        .where(eq(schema.conversations.id, conv.id))
        .returning();
    }

    return c.json(toConversation(conv, contact, await sendWindow(db, conv)), 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/stats",
    summary: "Inbox counts for the sidebar",
    description: "Open/unread totals, per-channel open counts, the queued-outbound count, and mine/unassigned ownership counts.",
    responses: {
      200: jsonRes(
        z
          .object({
            totalOpen: z.number(),
            totalUnread: z.number(),
            queued: z.number(),
            /** Open threads assigned to the caller; -1 when identity is absent. */
            mine: z.number(),
            unassigned: z.number(),
            channels: z.array(z.object({ channel: z.string(), open: z.number() })),
          })
          .openapi("Stats"),
        "Inbox counts",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const db = dbFor(c.env);

    const open = and(eq(schema.conversations.orgId, org), eq(schema.conversations.status, "open"));
    const me = user(c);
    const [channels, [totals], [queued], [mineRow], [unassignedRow]] = await Promise.all([
      db
        .select({ channel: schema.conversations.channel, open: count() })
        .from(schema.conversations)
        .where(open)
        .groupBy(schema.conversations.channel),
      db
        .select({
          totalOpen: count(),
          totalUnread: sql<number>`coalesce(sum(${schema.conversations.unread}), 0)`,
        })
        .from(schema.conversations)
        .where(open),
      db
        .select({ queued: count() })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, org), eq(schema.messages.status, "queued"))),
      db
        .select({ mine: count() })
        .from(schema.conversations)
        .where(me ? and(open, eq(schema.conversations.assigneeId, me.id)) : and(open, isNull(schema.conversations.id))),
      db
        .select({ unassigned: count() })
        .from(schema.conversations)
        .where(and(open, isNull(schema.conversations.assigneeId))),
    ]);

    return c.json(
      {
        totalOpen: totals.totalOpen,
        totalUnread: Number(totals.totalUnread),
        queued: queued.queued,
        mine: me ? mineRow.mine : 0,
        unassigned: unassignedRow.unassigned,
        channels,
      },
      200,
    );
  },
);

const IdParam = z.object({ id: z.string() });

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations/:id",
    summary: "Get one conversation",
    request: { params: IdParam },
    responses: {
      200: jsonRes(ConversationSchema, "The conversation"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const db = dbFor(c.env);
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, conv.contactId))
      .limit(1);
    return c.json(toConversation(conv, contact, await sendWindow(db, conv)), 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations/:id/messages",
    summary: "List messages in a conversation",
    description:
      "Chronological page of the thread — inbound/outbound messages, agent audit lines (kind=system) and internal notes (kind=comment). Use before=<ISO timestamp> to page further back.",
    request: {
      params: IdParam,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().optional(),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(MessageSchema), hasMore: z.boolean() }).openapi("MessagePage"),
        "One page of messages, oldest first",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [eq(schema.messages.conversationId, conv.id)];
    if (q.before) filters.push(lt(schema.messages.createdAt, q.before));

    // Fetch newest-first to find the page, return oldest-first for rendering.
    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(...filters))
      .orderBy(desc(schema.messages.createdAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).reverse().map(toMessage);
    return c.json({ items, hasMore }, 200);
  },
);

const ComposeSchema = z.object({ body: z.string().min(1) }).openapi("Compose");

const ReplySchema = z
  .object({
    /** Freeform text. Only accepted while the send window is open. Optional
     *  when an attachment carries the message. */
    body: z.string().min(1).optional(),
    /** An approved template. Always accepted — this is how a closed thread opens. */
    template: z
      .object({
        name: z.string().min(1),
        language: z.string().min(1),
        /** Placeholder token → value, e.g. {"1": "Kara"}. */
        variables: z.record(z.string()).default({}),
      })
      .optional(),
    /**
     * A file to send with (or instead of) the text — upload it first via
     * POST /api/uploads and pass back the returned `url`. Media counts as
     * freeform, so it is subject to the same 24-hour window.
     */
    attachment: z
      .object({
        url: z.string().min(1),
        /** image | video | audio | document — defaults from the stored MIME. */
        type: z.enum(["image", "video", "audio", "document"]).optional(),
      })
      .optional(),
    /** Send from this number instead of the org default (WhatsApp). */
    fromPhoneNumberId: z.string().optional(),
  })
  .openapi("Reply");

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/reply",
    summary: "Queue a reply to the contact",
    description:
      "Sends an outbound message. On channels the app can reach itself (WhatsApp) it goes out immediately and comes back status=sent or status=failed with the provider's reason. On other channels it is written status=queued for the agent to pick up from GET /api/outbox.\n\nSend EITHER `body` (freeform) OR `template`. An `attachment` (a url returned by POST /api/uploads) may ride with freeform text; it counts as freeform and is rejected with 409 when the 24-hour window is shut — on WhatsApp that is the provider's rule, not ours, so a 409 means send a template instead, not retry.",
    request: { params: IdParam, body: jsonBody(ReplySchema) },
    responses: {
      201: jsonRes(MessageSchema, "The queued outbound message"),
      400: jsonRes(ErrorSchema, "Send exactly one of body or template"),
      401: jsonRes(ErrorSchema, "No org identity"),
      403: jsonRes(ErrorSchema, "LinkedIn replies must come from a signed-in person, not the agent"),
      404: jsonRes(ErrorSchema, "Not found"),
      409: jsonRes(ErrorSchema, "Window shut — a template is required (WhatsApp), or the opening LinkedIn message is already out and the contact has not replied"),
      422: jsonRes(ErrorSchema, "Template unknown, not approved, or missing variables"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const input = c.req.valid("json");
    if (input.template && input.attachment) {
      return c.json({ error: "an attachment cannot ride a template" }, 400);
    }
    // Exactly one of template / (text or attachment). An attachment may ride
    // with text; it may not replace the template rule.
    if (!input.attachment && (!input.body === !input.template)) {
      return c.json({ error: "send exactly one of body or template" }, 400);
    }
    if (!input.body && !input.attachment && !input.template) {
      return c.json({ error: "write a message or attach a file" }, 400);
    }

    const u = user(c);
    const db = dbFor(c.env);
    const now = new Date().toISOString();

    // Every LinkedIn message leaves from a person's account in the agent's
    // browser, so each one is written and sent by a person here: the agent
    // delivers it, it never authors it. Text only, because a file has to be
    // uploaded through LinkedIn's own page, which is a second, riskier send.
    if (CONNECTION_CHANNELS.has(conv.channel)) {
      if (!u) {
        return c.json({ error: "LinkedIn replies must be written by a person in OpenChannels." }, 403);
      }
      if (input.attachment || input.template) {
        return c.json({ error: "LinkedIn replies are text only." }, 400);
      }
    }

    // Only this app's own stored files may be attached, and only ones uploaded
    // through the composer (att/*). Handing Meta an arbitrary URL is a fetch
    // proxy in disguise; handing it a conversation's stored inbound media is a
    // privacy leak the URL shape invites by accident.
    let attachment: Attachment | null = null;
    if (input.attachment) {
      let parsed: URL;
      try {
        parsed = new URL(input.attachment.url);
      } catch {
        return c.json({ error: "attachment.url must be the url returned by POST /api/uploads" }, 400);
      }
      const key = parsed.pathname.replace(/^\/api\/media\//, "");
      if (parsed.origin !== new URL(c.req.url).origin || !parsed.pathname.startsWith("/api/media/") || !/^att\//.test(key)) {
        return c.json(
          { error: "attachment.url must be the url returned by POST /api/uploads" },
          400,
        );
      }
      // The object must actually exist in this deployment's bucket — the app
      // cannot vouch for a URL whose file it does not hold.
      const obj = typeof c.env.UPLOADS?.head === "function" ? await c.env.UPLOADS.head(key) : null;
      if (!obj) {
        return c.json({ error: "that attachment is not stored here — upload it first" }, 400);
      }
      const mime = (obj.httpMetadata?.contentType as string | undefined) ?? null;
      attachment = {
        key,
        url: input.attachment.url,
        type:
          input.attachment.type ??
          mimeToKind(mime),
        mime,
        name: obj.customMetadata?.name ?? null,
      };
    }

    let body: string;
    let templateFields: {
      templateName: string | null;
      templateLanguage: string | null;
      templateVariables: string | null;
    } = { templateName: null, templateLanguage: null, templateVariables: null };

    if (input.template) {
      const [tpl] = await db
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.orgId, conv.orgId),
            eq(schema.templates.channel, conv.channel),
            eq(schema.templates.name, input.template.name),
            eq(schema.templates.language, input.template.language),
          ),
        )
        .limit(1);
      if (!tpl) {
        return c.json(
          { error: `no template "${input.template.name}" (${input.template.language}) on ${conv.channel}` },
          422,
        );
      }
      if (tpl.status !== "APPROVED") {
        return c.json({ error: `template "${tpl.name}" is ${tpl.status}, not APPROVED` }, 422);
      }
      const required = JSON.parse(tpl.variables) as string[];
      const missing = required.filter((t) => !input.template!.variables[t]?.trim());
      if (missing.length > 0) {
        return c.json({ error: `template needs values for: ${missing.join(", ")}` }, 422);
      }

      body = renderTemplate(tpl.bodyText, input.template.variables);
      templateFields = {
        templateName: tpl.name,
        templateLanguage: tpl.language,
        templateVariables: JSON.stringify(input.template.variables),
      };
    } else {
      // Media is freeform — the channel would reject it outside the window
      // exactly as it rejects freeform text.
      const w = await sendWindow(db, conv);
      if (!w.freeformAllowed) {
        return c.json(
          {
            error: CONNECTION_CHANNELS.has(conv.channel)
              ? "You've already sent this person a message on LinkedIn. You can write again once they reply."
              : w.lastInboundAt === null
                ? "This contact has never written — open the thread with an approved template."
                : "The 24-hour window has closed — re-engage with an approved template.",
          },
          409,
        );
      }
      body = input.body ?? "";
    }

    // Send now when the app can reach the channel; otherwise queue for the
    // agent. `queued` should mean "waiting on the agent", never "waiting on a
    // heartbeat to relay something we could have sent ourselves".
    const sender = CHANNEL_SENDERS[conv.channel];
    let status = "queued";
    let error: string | null = null;
    let externalId: string | null = null;

    if (sender) {
      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, conv.contactId))
        .limit(1);
      try {
        const sent = await sender(c.env, contact.handle, {
          body,
          template: input.template
            ? {
                name: templateFields.templateName!,
                language: templateFields.templateLanguage!,
                variables: input.template.variables,
              }
            : undefined,
          attachment,
          // Kept apart on purpose. A number picked in the composer is a human's
          // decision and is honoured as-is; the default is only a fallback, so
          // the sender may prefer a number local to the recipient over it.
          fromPhoneNumberId: input.fromPhoneNumberId ?? null,
          defaultPhoneNumberId: await readSetting(db, conv.orgId, DEFAULT_PHONE_KEY),
          // Only a template may pick a local number. The 24-hour window belongs
          // to the number the contact actually wrote to, and we do not record
          // which one that was — so switching sender on a freeform reply would
          // send it to a number with no open session, and WhatsApp would refuse
          // it. A template needs no session, so it is always safe.
          preferLocal: !!input.template,
        });
        // Meta replies `accepted` — queued for delivery, NOT delivered. It can
        // still be dropped (no opt-in, marketing caps, quality limits) and the
        // only notice is a delivery receipt on the status webhook. Claiming
        // "sent" here is how a silently-dropped message looks successful.
        status = "accepted";
        externalId = sent.externalId;
      } catch (err) {
        // Record the failure on the message rather than losing the draft —
        // the thread shows why, and the text is still there to retry.
        status = "failed";
        error = `${err}`;
      }
    }

    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "outbound",
        body,
        status,
        error,
        externalId,
        authorName: u?.name ?? u?.email ?? "Agent",
        userId: u?.id ?? null,
        mediaKey: attachment?.key ?? null,
        mediaType: attachment?.type ?? null,
        mediaMime: attachment?.mime ?? null,
        mediaName: attachment?.name ?? null,
        ...templateFields,
        createdAt: now,
      })
      .returning();

    await db
      .update(schema.conversations)
      .set({
        lastMessageAt: now,
        lastMessagePreview: preview(body || (attachment ? `[${attachment.type}]` : "")),
        unread: 0,
      })
      .where(eq(schema.conversations.id, conv.id));

    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/comment",
    summary: "Add an internal note",
    description: "A note visible only in this inbox — never delivered to the contact.",
    request: { params: IdParam, body: jsonBody(ComposeSchema) },
    responses: {
      201: jsonRes(MessageSchema, "The note"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const { body } = c.req.valid("json");
    const u = user(c);
    const db = dbFor(c.env);

    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "comment",
        body,
        authorName: u?.name ?? u?.email ?? (caller(c) === "agent" ? "Agent" : "Someone"),
        userId: u?.id ?? null,
      })
      .returning();
    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/events",
    summary: "Log an agent action on the conversation (audit line)",
    description:
      'Appends a kind=system line to the thread — the audit trail humans review. Log every action taken on this conversation: "Drafted a reply for review", "Booked the appointment", "Escalated to Sara".',
    request: { params: IdParam, body: jsonBody(ComposeSchema) },
    responses: {
      201: jsonRes(MessageSchema, "The audit line"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const { body } = c.req.valid("json");
    const db = dbFor(c.env);
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "system",
        body,
        authorName: "Agent",
      })
      .returning();
    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "patch",
    path: "/api/conversations/:id",
    summary: "Update conversation state",
    description: "Close/reopen the thread, clear its unread flag, or assign it to the caller (or clear the assignment).",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({
            status: z.enum(["open", "closed"]).optional(),
            unread: z.literal(0).optional(),
            /** "me" assigns the thread to the calling user; null clears it. */
            assignee: z.union([z.literal("me"), z.null()]).optional(),
          })
          .openapi("ConversationPatch"),
      ),
    },
    responses: {
      200: jsonRes(OkSchema, "Updated"),
      400: jsonRes(ErrorSchema, "Empty patch"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const body = c.req.valid("json");
    const patch: Partial<typeof schema.conversations.$inferInsert> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.unread !== undefined) patch.unread = body.unread;
    if (body.assignee !== undefined) {
      if (body.assignee === "me") {
        const u = user(c);
        if (!u) return c.json({ error: "no identity — cannot assign" }, 401);
        patch.assigneeId = u.id;
        patch.assigneeName = u.name;
      } else {
        patch.assigneeId = null;
        patch.assigneeName = null;
      }
    }
    if (Object.keys(patch).length === 0) return c.json({ error: "empty patch" }, 400);
    const db = dbFor(c.env);
    await db.update(schema.conversations).set(patch).where(eq(schema.conversations.id, conv.id));
    return c.json({ ok: true }, 200);
  },
);

/* --------------------------------- templates ------------------------------- */

api.openapi(
  createRoute({
    method: "post",
    path: "/api/templates/refresh",
    summary: "Pull the approved template catalogue from the provider",
    description:
      "Fetches the channel's templates through the org's own connected integration and replaces the stored catalogue. The app does this itself — no agent turn — so the picker is never stale because an agent was asleep. Safe to call from a button; it is a full replace, so a template the provider has withdrawn disappears here too.",
    request: {
      body: jsonBody(
        z
          .object({ channel: z.enum(CHANNELS).default("whatsapp") })
          .openapi("TemplateRefresh"),
      ),
    },
    responses: {
      200: jsonRes(
        z.object({ channel: z.string(), count: z.number() }).openapi("TemplateRefreshResult"),
        "Catalogue refreshed",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      424: jsonRes(ErrorSchema, "The channel's integration isn't connected or returned an error"),
      501: jsonRes(ErrorSchema, "Channel has no template catalogue"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { channel } = c.req.valid("json");

    const source = TEMPLATE_SOURCES[channel];
    if (!source) {
      return c.json({ error: `${channel} has no template catalogue to refresh` }, 501);
    }

    let templates: ProviderTemplate[];
    try {
      templates = await source(c.env);
    } catch (err) {
      // Surfaced verbatim in the composer — "not connected" and "token expired"
      // need different fixes, so don't flatten them into one message.
      return c.json({ error: `could not reach ${channel}: ${err}` }, 424);
    }

    try {
      const count = await replaceCatalogue(dbFor(c.env), org, channel, templates);
      return c.json({ channel, count }, 200);
    } catch (err) {
      // A bare 500 tells the operator nothing; say what broke while storing.
      return c.json({ error: `fetched ${templates.length} templates but could not store them: ${err}` }, 424);
    }
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/templates",
    summary: "List templates available to send",
    description:
      "Paginated catalogue for the composer's template picker. Defaults to APPROVED only — those are the only ones a channel will actually accept. Use ?search= to narrow by name or body text.",
    request: {
      query: z.object({
        channel: z.enum(CHANNELS).optional(),
        status: z.string().default("APPROVED"),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(TemplateSchema), total: z.number() }).openapi("TemplatePage"),
        "One page of templates",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [eq(schema.templates.orgId, org)];
    if (q.channel) filters.push(eq(schema.templates.channel, q.channel));
    if (q.status !== "all") filters.push(eq(schema.templates.status, q.status));
    if (q.search) {
      const term = `%${q.search}%`;
      filters.push(or(like(schema.templates.name, term), like(schema.templates.bodyText, term))!);
    }
    const where = and(...filters);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.templates)
        .where(where)
        .orderBy(asc(schema.templates.name))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(schema.templates).where(where),
    ]);

    return c.json({ items: rows.map(toTemplate), total }, 200);
  },
);

/* ------------------------ writing a template to Meta ----------------------- */

/**
 * Templates are WABA-scoped except edits, which Meta addresses by template id.
 * The own-tier `whatsapp-business` connection makes these documented Graph
 * calls with the org's integration token; no Composio action is involved.
 *
 * The samples are never optional. A body with variables and no examples is one
 * Meta can only categorise as AUTHENTICATION, and the write is refused.
 */
/**
 * The provider's own complaint, recovered from whatever the SDK threw.
 *
 * `run()` throws `new Error(r.error)` on failure, and that error is sometimes an
 * object, which stringifies to the useless "[object Object]" — precisely when
 * the detail matters most. An uncaught rejection here would surface as a bare
 * 500, and the provider's complaint (wrong category, malformed component,
 * missing sample) is the only thing that tells the person editing what to fix.
 */
function providerError(e: unknown): string {
  const raw = (e as { message?: unknown })?.message ?? e;
  if (typeof raw === "string" && raw !== "[object Object]") return raw.slice(0, 500);
  try {
    return JSON.stringify(raw).slice(0, 500);
  } catch {
    return String(raw).slice(0, 500);
  }
}

/**
 * Meta's `example` block for a body, in the shape that matches its placeholders.
 *
 * Positional (`{{1}}`) and named (`{{first_name}}`) templates take different
 * keys, and sending the wrong one is rejected as a malformed component.
 */
function bodyExample(
  placeholders: string[],
  samples: string[],
): Record<string, unknown> | undefined {
  if (placeholders.length === 0) return undefined;
  const positional = placeholders.every((p) => /^\d+$/.test(p));
  return positional
    ? // An array of example SETS, not an array of values — one set here.
      { body_text: [samples] }
    : {
        body_text_named_params: placeholders.map((p, i) => ({
          param_name: p,
          example: samples[i] ?? "",
        })),
      };
}

/** The samples already on a stored template, whichever shape they arrived in. */
function samplesOf(components: unknown[]): string[] {
  for (const comp of components) {
    const c = comp as { type?: string; example?: Record<string, unknown> };
    if (c?.type?.toUpperCase() !== "BODY" || !c.example) continue;
    const positional = c.example.body_text;
    if (Array.isArray(positional)) {
      // `[["Lexie", "a nut allergy"]]` — take the first set. A flat array is
      // not a shape Meta returns, but costs one line to survive.
      const first = positional[0];
      return Array.isArray(first) ? first.map(String) : positional.map(String);
    }
    const named = c.example.body_text_named_params;
    if (Array.isArray(named)) {
      return named.map((p) => String((p as { example?: unknown })?.example ?? ""));
    }
  }
  return [];
}

/**
 * The components array as the WRITE side accepts it — not as the read side
 * returned it. Meta hands back fields the write rejects, so each component is
 * rebuilt from the keys the action declares rather than echoed back.
 *
 * Only BODY text is ours to change. Headers, footers and buttons carry through
 * untouched: they are a different editing problem (media, URLs, quick replies)
 * and pretending otherwise in a plain text box loses them.
 */
function componentsForWrite(
  stored: unknown[],
  bodyText: string,
  example: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const carried = stored.map((comp) => {
    const c = comp as Record<string, unknown>;
    const out: Record<string, unknown> = { type: c.type };
    if (typeof c.text === "string") out.text = c.text;
    if (typeof c.format === "string") out.format = c.format;
    if (Array.isArray(c.buttons)) out.buttons = c.buttons;
    if (c.example && (c.type as string)?.toUpperCase() !== "BODY") out.example = c.example;
    return out;
  });

  const body: Record<string, unknown> = { type: "BODY", text: bodyText };
  if (example) body.example = example;

  const hasBody = carried.some((c) => (c.type as string)?.toUpperCase() === "BODY");
  return hasBody
    ? carried.map((c) => ((c.type as string)?.toUpperCase() === "BODY" ? body : c))
    : [...carried, body];
}

/** Meta's name rule, checked here so a typo fails before a round trip. */
const TEMPLATE_NAME = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores only");

const CATEGORIES = ["AUTHENTICATION", "MARKETING", "UTILITY"] as const;

/**
 * Create a template at the provider.
 *
 * It is created THERE and mirrored here, same as every other row — the local
 * row exists so the catalogue is complete without a resync, and starts at
 * PENDING because a new template is never immediately sendable.
 *
 * `allow_category_change` is sent because Meta re-derives the category from the
 * copy and refuses the write when its verdict differs from ours. On a new
 * template letting Meta's verdict win is strictly better than bouncing the
 * person back to guess again; on an EDIT it cannot help, because Meta will not
 * move an existing template between categories at all.
 */
api.openapi(
  createRoute({
    method: "post",
    path: "/api/templates",
    summary: "Create a template at the provider",
    description:
      "Submits a new template to the channel's provider and mirrors it here as PENDING. Every {{n}} in the body needs a sample value — a template with variables and no samples can only be categorised AUTHENTICATION, and the provider rejects it. The template is not sendable until the provider approves it.",
    request: {
      body: jsonBody(
        z
          .object({
            channel: z.enum(CHANNELS).default("whatsapp"),
            name: TEMPLATE_NAME,
            /** Meta's own code, e.g. "en_US" or "en" — not normalised here. */
            language: z.string().min(2).max(10),
            category: z.enum(CATEGORIES),
            bodyText: z.string().min(1).max(1024),
            /** One per {{n}} in bodyText, in order of first appearance. */
            samples: z.array(z.string()).default([]),
          })
          .openapi("TemplateCreate"),
      ),
    },
    responses: {
      200: jsonRes(TemplateSchema, "Submitted to the provider; awaiting review"),
      400: jsonRes(ErrorSchema, "A sample is missing for a variable in the body"),
      401: jsonRes(ErrorSchema, "No org identity"),
      409: jsonRes(ErrorSchema, "That name and language already exist"),
      424: jsonRes(ErrorSchema, "The provider rejected the template"),
      501: jsonRes(ErrorSchema, "Channel has no templates to create"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const input = c.req.valid("json");
    if (input.channel !== "whatsapp") {
      return c.json({ error: `${input.channel} has no templates to create` }, 501);
    }
    const db = dbFor(c.env);

    const variables = placeholdersIn(input.bodyText);
    if (variables.length !== input.samples.length) {
      return c.json(
        {
          error: `the body has ${variables.length} variable(s) (${variables
            .map((v) => `{{${v}}}`)
            .join(" ")}) and ${input.samples.length} sample(s) — the provider needs one example value per variable`,
        },
        400,
      );
    }

    const [clash] = await db
      .select({ id: schema.templates.id })
      .from(schema.templates)
      .where(
        and(
          eq(schema.templates.orgId, org),
          eq(schema.templates.channel, input.channel),
          eq(schema.templates.name, input.name),
          eq(schema.templates.language, input.language),
        ),
      )
      .limit(1);
    if (clash) {
      return c.json(
        { error: `"${input.name}" already exists in ${input.language} — edit that one instead` },
        409,
      );
    }

    const components = componentsForWrite(
      [],
      input.bodyText,
      bodyExample(variables, input.samples),
    );

    // What Meta answers a create with: the new template's id, and the status
    // and category it decided on.
    type CreatedTemplate = { id?: unknown; status?: unknown; category?: unknown };
    let created: CreatedTemplate | null = null;
    try {
      const { client, wabaId } = whatsappBusiness(c.env);
      created = (await client.post(wabaEndpoint(wabaId, "message_templates"), {
        name: input.name,
        language: input.language,
        category: input.category,
        components,
        allow_category_change: true,
      })) as CreatedTemplate | null;
    } catch (e) {
      return c.json({ error: providerError(e) }, 424);
    }

    // Meta's answer arrives either bare or inside the broker's `data` envelope,
    // the same as every read here. One unwrap, then read it either way.
    const answer: CreatedTemplate =
      created && typeof (created as { data?: unknown }).data === "object"
        ? ((created as { data: CreatedTemplate }).data ?? {})
        : (created ?? {});

    const [row] = await db
      .insert(schema.templates)
      .values({
        orgId: org,
        channel: input.channel,
        name: input.name,
        language: input.language,
        // Meta answers with the category it actually assigned, which is the
        // point of allow_category_change — store its verdict, not our request.
        category: typeof answer.category === "string" ? answer.category : input.category,
        status: typeof answer.status === "string" ? answer.status.toUpperCase() : "PENDING",
        bodyText: input.bodyText,
        variables: JSON.stringify(variables),
        components: JSON.stringify(components),
        externalId: typeof answer.id === "string" ? answer.id : null,
      })
      .returning();

    return c.json(toTemplate(row), 200);
  },
);

/**
 * Edit a template's body text, at the provider.
 *
 * This is a WRITE TO META, not a local edit. The catalogue here is a mirror —
 * changing a row would only be overwritten by the next sync, and would send
 * copy the provider never approved.
 *
 * Three consequences the UI has to be honest about, because all three surprised
 * us when they happened by hand:
 *
 *   1. **It goes back into review.** Meta re-reviews a template on every edit,
 *      so an approved template becomes PENDING the moment you save. We set that
 *      locally straight away rather than leaving the row saying APPROVED until
 *      the next sync — the picker must not offer copy that will bounce.
 *
 *   2. **Changing the number of `{{n}}` placeholders breaks every automation
 *      that sends it.** The provider rejects a send whose variable count does
 *      not match, so anything scheduled against this template starts failing
 *      silently. Callers get `variables_changed` back so they can say so;
 *      whether that is a warning or a block belongs to whoever knows what
 *      consumes the template, which is not this app.
 *
 *   3. **The category cannot move.** Meta refuses an edit whose category
 *      differs from the one already on the template ("The category UTILITY
 *      doesn't match the one that's already associated with this template,
 *      MARKETING"), so the stored category is sent back verbatim and is not an
 *      editable field here.
 *
 * Samples ride along with every edit: the write carries the whole component, so
 * omitting them would strip the examples off an approved template and leave it
 * uncategorisable. Existing samples are reused when the variable count is
 * unchanged; when it changes, the caller has to supply new ones.
 */
api.openapi(
  createRoute({
    method: "patch",
    path: "/api/templates/:id",
    summary: "Edit a template's body text at the provider",
    description:
      "Submits new body text to the channel's provider and marks the local row as awaiting review. The template leaves the send picker until the provider approves it again — that is the provider's rule, not ours. Returns `variables_changed: true` when the edit alters the {{n}} placeholders, which is the change that breaks automations already sending this template. Supply `samples` when the edit changes how many variables the body has; otherwise the samples already on the template are reused.",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({
            bodyText: z.string().min(1).max(1024),
            /** One per {{n}}. Omit to keep the template's current samples. */
            samples: z.array(z.string()).optional(),
          })
          .openapi("TemplateEdit"),
      ),
    },
    responses: {
      200: jsonRes(
        z
          .object({
            template: TemplateSchema,
            variables_changed: z.boolean(),
            variables_before: z.array(z.string()),
            variables_after: z.array(z.string()),
          })
          .openapi("TemplateEditResult"),
        "Submitted to the provider; awaiting review",
      ),
      400: jsonRes(ErrorSchema, "A sample is missing for a variable in the body"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "No such template"),
      409: jsonRes(ErrorSchema, "The row has no provider id — sync, then edit"),
      424: jsonRes(ErrorSchema, "The provider rejected the edit"),
      501: jsonRes(ErrorSchema, "Channel has no editable templates"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const { bodyText, samples } = c.req.valid("json");
    const db = dbFor(c.env);

    const [row] = await db
      .select()
      .from(schema.templates)
      .where(and(eq(schema.templates.orgId, org), eq(schema.templates.id, id)))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.channel !== "whatsapp") {
      return c.json({ error: `${row.channel} templates are not editable here` }, 501);
    }

    const before = placeholdersIn(row.bodyText);
    const after = placeholdersIn(bodyText);

    // Carry every other component through unchanged; swap only BODY's text.
    let stored: unknown[];
    try {
      const parsed = JSON.parse(row.components) as unknown[];
      stored = Array.isArray(parsed) ? parsed : [];
    } catch {
      stored = [];
    }

    // Reuse what is already on the template unless the caller sent new samples.
    // The write replaces the whole BODY component, so samples that are not sent
    // are samples REMOVED — and a template with variables and no samples is one
    // Meta will only accept as AUTHENTICATION.
    const values = samples ?? samplesOf(stored);
    if (values.length !== after.length) {
      return c.json(
        {
          error: `this edit leaves ${after.length} variable(s) (${after
            .map((v) => `{{${v}}}`)
            .join(" ")}) but ${values.length} sample(s) — send one example value per variable`,
        },
        400,
      );
    }

    // Meta addresses an edit by template id, not by name + language, so a row
    // we never learned an id for cannot be edited — and guessing by name would
    // edit whichever language variant Meta picked.
    if (!row.externalId) {
      return c.json(
        { error: `"${row.name}" has no provider id here — sync from the provider first` },
        409,
      );
    }

    const components = componentsForWrite(stored, bodyText, bodyExample(after, values));
    try {
      // Meta's own edit endpoint. `category`
      // is deliberately absent: an edit that names one is refused when Meta's
      // verdict differs ("The category UTILITY doesn't match the one that's
      // already associated with this template, MARKETING"), and omitting it
      // leaves the template exactly where it was — which is what an edit to
      // the copy should do.
      const { client } = whatsappBusiness(c.env);
      await client.post(objectEndpoint(row.externalId, "template ID"), { components });
    } catch (e) {
      return c.json({ error: providerError(e) }, 424);
    }

    const [updated] = await db
      .update(schema.templates)
      .set({
        bodyText,
        variables: JSON.stringify(after),
        components: JSON.stringify(components),
        // Its own truth until the next sync: an edited template is in review,
        // and the picker filters on APPROVED.
        status: "PENDING",
        syncedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.templates.orgId, org), eq(schema.templates.id, id)))
      .returning();

    return c.json(
      {
        template: toTemplate(updated),
        variables_changed: before.length !== after.length,
        variables_before: before,
        variables_after: after,
      },
      200,
    );
  },
);

/**
 * Delete a template at the provider, and stop mirroring it here.
 *
 * Two properties of the provider's delete make this more than a DELETE row:
 *
 *   1. **It is not reversible, and the name is burned.** Meta blocks re-use of
 *      a deleted template's name for 30 days, so "delete and recreate to fix a
 *      typo" is a month without that template. Editing is the repair; deleting
 *      is for copy that should stop existing.
 *
 *   2. **Deleting by name deletes every language.** Meta's delete takes a name
 *      and removes all of its language variants unless `hsm_id` narrows it to
 *      one. We always narrow, and refuse when we cannot: a row with no provider
 *      id came from somewhere we cannot pin down, and taking out an unrelated
 *      language because of that is not a mistake this app gets to make.
 */
api.openapi(
  createRoute({
    method: "delete",
    path: "/api/templates/:id",
    summary: "Delete a template at the provider",
    description:
      "Deletes this template's language variant at the provider and removes the mirrored row. Not reversible: the provider blocks re-use of the name for 30 days, so use an edit to fix copy and a delete only to retire it.",
    request: { params: IdParam },
    responses: {
      200: jsonRes(
        z
          .object({ deleted: z.string(), name: z.string(), language: z.string() })
          .openapi("TemplateDeleted"),
        "Deleted at the provider and here",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "No such template"),
      409: jsonRes(ErrorSchema, "The row has no provider id — sync, then delete"),
      424: jsonRes(ErrorSchema, "The provider refused the delete"),
      501: jsonRes(ErrorSchema, "Channel has no deletable templates"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const db = dbFor(c.env);

    const [row] = await db
      .select()
      .from(schema.templates)
      .where(and(eq(schema.templates.orgId, org), eq(schema.templates.id, id)))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.channel !== "whatsapp") {
      return c.json({ error: `${row.channel} templates are not deletable here` }, 501);
    }
    if (!row.externalId) {
      return c.json(
        {
          error: `"${row.name}" has no provider id here, and deleting by name alone would take every language variant with it — sync from the provider first`,
        },
        409,
      );
    }

    try {
      const { client, wabaId } = whatsappBusiness(c.env);
      await client.delete(wabaEndpoint(wabaId, "message_templates"), {
        query: {
          name: row.name,
        // Narrows the delete to this one language variant. Without it Meta
        // deletes every language sharing the name.
          hsm_id: row.externalId,
        },
      });
    } catch (e) {
      return c.json({ error: providerError(e) }, 424);
    }

    // Only after the provider agreed. Dropping the row first would hide a
    // template that is still live and still sendable by anything holding its
    // name.
    await db
      .delete(schema.templates)
      .where(and(eq(schema.templates.orgId, org), eq(schema.templates.id, id)));

    return c.json({ deleted: id, name: row.name, language: row.language }, 200);
  },
);

/* --------------------------------- sending -------------------------------- */

/**
 * Channels the app can send on itself.
 *
 * A human clicking Send should send — not wait for an agent heartbeat to relay
 * text they already wrote. The agent keeps its own send path for messages IT
 * originates (where allowlists and approval rules belong); a person acting in
 * the dashboard is already authorised, so gating them behind an agent turn adds
 * latency, an agent-liveness dependency, and an LLM turn spent copying a string.
 *
 * Channels absent here still queue to /api/outbox for the agent, unchanged.
 */
type SendResult = { externalId: string | null };

/** Which number outbound WhatsApp leaves from. */
const DEFAULT_PHONE_KEY = "whatsapp_default_phone_number_id";

// ── Profile source: the org's system of record for people ───────────────────
//
// The inbox stores channel identities, not people. The org's CRM stores people.
// This is the seam between them, and it is deliberately *configuration* rather
// than code: this app is a public template, so it cannot know which app an org
// uses as its CRM, what its routes are called, or which field holds a phone
// number. One org points it at a members app, another at a customers app.
//
// It is config and not a table because it has no lifecycle — one value per org,
// last write wins, nothing to revoke or audit. The *link* on a contact row is
// the opposite: a durable fact about one person, so that gets columns.
//
// Every key here exists because a real app differs on it — `collection` because
// some APIs return a bare array and some wrap it, `query` because the search
// parameter is `search` in one app and `q` in the next. Resist adding keys for
// differences nobody has hit; a mapping DSL is not the goal.
const PROFILE_SOURCE_KEY = "profile_source";

interface ProfileSource {
  /** Sibling app's platform UUID — must be in this org. */
  appId: string;
  /** Human label for the UI, e.g. "Add One Hub". */
  label?: string;
  /** How to search it. `collection` names the array key in the response body. */
  search: { path: string; query: string; collection?: string };
  /** How to fetch one record. `{ref}` is substituted. */
  get?: { path: string; collection?: string };
  /** Which response fields carry which meaning. `ref` is the record's id. */
  fields: { ref: string; name?: string; phone?: string; email?: string };
  /** Optional deep link for humans; `{ref}` is substituted. */
  profileUrl?: string;
}

const readProfileSource = async (db: DB, org: string, env: Env["Bindings"]): Promise<ProfileSource | null> => {
  const raw = await readSetting(db, org, PROFILE_SOURCE_KEY);
  if (!raw) return env.CRM_APP_ID ? {
    appId: env.CRM_APP_ID,
    label: "CRM",
    search: { path: "/api/contacts", query: "search", collection: "contacts" },
    get: { path: "/api/contacts/{ref}", collection: "contact" },
    fields: { ref: "id", name: "first_name", email: "email", phone: "phone" },
  } : null;
  try {
    const parsed = JSON.parse(raw) as ProfileSource;
    // A half-written config is worse than none: it would fail deep inside a
    // proxy call with an opaque message instead of here.
    return parsed?.appId && parsed?.search?.path && parsed?.fields?.ref ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Call a sibling app in this org through the platform's app-to-app proxy.
 *
 * Auth is this app's own injected CLAWNIFY_TOKEN — the org service token. The
 * callee sees Caller "app" with no user identity, so it must not be relied on
 * for per-user gating on the other side. The platform scopes the app lookup to
 * our org, so a mis-typed appId is a 404, never another tenant's data.
 */
const callSibling = async (
  env: Env["Bindings"],
  appId: string,
  path: string,
): Promise<unknown> => {
  const token = env.CLAWNIFY_TOKEN;
  if (!token) {
    throw new Error("this app has no CLAWNIFY_TOKEN — redeploy it to pick one up");
  }
  const res = await fetch(`https://provision.clawnify.com/v1/apps/${appId}/proxy${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the sibling's own words — "App not found." reads very differently
    // from a 500 in its handler, and the operator needs to tell them apart.
    const detail = text.slice(0, 200);
    throw new Error(
      res.status === 404
        ? `profile source app not found in this org (${appId}) — check the configured appId`
        : `profile source returned ${res.status}: ${detail}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("profile source did not return JSON");
  }
};

/** Pull the record array out of a response that may or may not wrap it. */
const collectionOf = (body: unknown, key?: string): Record<string, unknown>[] => {
  const raw = key ? (body as Record<string, unknown>)?.[key] : body;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** Project one sibling record onto the shape the inbox understands. */
const toProfile = (row: Record<string, unknown>, src: ProfileSource) => ({
  ref: str(row[src.fields.ref]),
  name: src.fields.name ? str(row[src.fields.name]) : null,
  phone: src.fields.phone ? str(row[src.fields.phone]) : null,
  email: src.fields.email ? str(row[src.fields.email]) : null,
  profileUrl:
    src.profileUrl && str(row[src.fields.ref])
      ? src.profileUrl.replace("{ref}", encodeURIComponent(String(row[src.fields.ref])))
      : null,
});

const readSetting = async (db: DB, org: string, key: string): Promise<string | null> => {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.orgId, org), eq(schema.settings.key, key)))
    .limit(1);
  return row?.value ?? null;
};

/**
 * Dialling codes we hold sending numbers in.
 *
 * Ordered longest first because codes are not fixed width: matching "1" before
 * "31" would make every Dutch number look American. Add a code here when the
 * account gains a number in a new country — an unlisted one simply means no
 * local match, and the send falls back to the default rather than misrouting.
 */
const DIALLING_CODES = ["353", "31", "44", "49", "61", "1"];

const dialCode = (number: string): string => {
  const digits = number.replace(/\D/g, "");
  return DIALLING_CODES.find((code) => digits.startsWith(code)) ?? "";
};

/**
 * A predicate for "this sender is in the same country as the recipient".
 *
 * WhatsApp does not require it, but a local number is what the recipient
 * recognises, and a +1 contact receiving from a Dutch number reads as spam —
 * which is the likeliest reason a confirmation to a US number came back
 * undelivered on 12 Aug 2026.
 */
const sameCountry = (to: string) => {
  const want = dialCode(to);
  return (phone: { displayPhoneNumber: string }) =>
    want !== "" && dialCode(phone.displayPhoneNumber) === want;
};

type Attachment = {
  /** Storage key under the app's own bucket (always `att/*` when sent). */
  key: string;
  /** Public URL Meta fetches the bytes from. */
  url: string;
  type: "image" | "video" | "audio" | "document";
  mime: string | null;
  name: string | null;
};

const CHANNEL_SENDERS: Record<
  string,
  (
    env: Env["Bindings"],
    to: string,
    message: {
      body: string;
      template?: { name: string; language: string; variables: Record<string, string> };
      attachment?: Attachment | null;
      /** Explicit sending number — a human chose it. Always honoured. */
      fromPhoneNumberId?: string | null;
      /** The org default, used only when nothing better applies. */
      defaultPhoneNumberId?: string | null;
      /** May this send switch to a number local to the recipient? */
      preferLocal?: boolean;
    },
  ) => Promise<SendResult>
> = {
  whatsapp: async (env, to, message) => {
    const { client, wabaId } = whatsappBusiness(env);

    // Meta wants the sending number's id, not the number.
    const phones = metaPhones(await client.get(wabaEndpoint(wabaId, "phone_numbers")));
    const registered = phones.filter((p) => p.registered);
    if (registered.length === 0) {
      throw new Error(
        "no registered WhatsApp number to send from — register one in WhatsApp setup first",
      );
    }

    // Override → a number local to the recipient → configured default → the
    // only registered number. Never fall back to "the first one" when several
    // exist: the number the recipient sees is not something to leave to
    // provider ordering.
    //
    // The local step is what stops a message to a +1 contact leaving from the
    // Dutch number. Automated senders — the flows and the Hub — pass no number
    // at all, so before this they all landed on the org default whoever they
    // were writing to.
    const local = sameCountry(to);
    const from = message.fromPhoneNumberId
      ? registered.find((p) => p.id === message.fromPhoneNumberId)
      : ((message.preferLocal ? registered.find(local) : undefined) ??
        (message.defaultPhoneNumberId
          ? registered.find((p) => p.id === message.defaultPhoneNumberId)
          : undefined) ??
        (registered.length === 1 ? registered[0] : undefined));
    if (!from) {
      throw new Error(
        message.fromPhoneNumberId
          ? `phone number ${message.fromPhoneNumberId} is not registered on this account`
          : "several registered numbers and no default — set one in WhatsApp setup",
      );
    }

    // Digits only, no '+' — Meta rejects the plus form.
    const toDigits = to.replace(/\D/g, "");

    // Media goes out by public link, not by upload: Meta fetches the URL
    // itself. body rides along as the caption image/video/document allow.
    const attachment = message.attachment;
    const mediaType = attachment?.type;
    const payload = attachment
      ? {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toDigits,
          type: mediaType,
          [mediaType ?? "document"]: {
            link: attachment.url,
            ...(mediaType === "document" && attachment.name ? { filename: attachment.name } : {}),
            ...(mediaType !== "audio" && message.body ? { caption: message.body } : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toDigits,
          type: "text",
          text: { preview_url: false, body: message.body },
        };

    const result = message.template
      ? await client.post(`${objectEndpoint(from.id, "phone number ID")}/messages`, {
          messaging_product: "whatsapp",
          to: toDigits,
          type: "template",
          template: {
            name: message.template.name,
            language: { code: message.template.language },
            components: templateComponents(message.template.variables),
          },
        })
      : await client.post(`${objectEndpoint(from.id, "phone number ID")}/messages`, payload);

    return { externalId: wamidOf(result) };
  },
};

/**
 * Meta takes template variables as positional BODY parameters, in order —
 * `{{1}}` is the first entry, not a name/value pair.
 */
function templateComponents(variables: Record<string, string>) {
  const ordered = Object.keys(variables)
    .sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)))
    .map((k) => ({ type: "text", text: variables[k] }));
  return ordered.length ? [{ type: "body", parameters: ordered }] : [];
}

/**
 * The wamid Meta returns for a sent message, so delivery receipts can match it.
 *
 * A send response is `{ contacts: [...], messages: [{ id }] }` — NOT the
 * `{ data: [...] }` list shape, so the list unwrapper walks straight past it
 * and yields null. Walk to `messages` explicitly instead.
 */
function wamidOf(result: unknown): string | null {
  const seen = new Set<unknown>();
  let node: unknown = result;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      const first = obj.messages[0] as { id?: unknown } | undefined;
      return typeof first?.id === "string" ? first.id : null;
    }
    node = obj.data;
  }
  return null;
}

/* ----------------------------- what was sent ------------------------------ */

const SentTemplateSchema = z
  .object({
    handle: z.string(),
    channel: z.string(),
    templateName: z.string(),
    /** accepted = the provider took it; sent = confirmed by the agent. */
    status: z.string().nullable(),
    at: z.string(),
    /** Who sent it — a person's name, or "Agent" for an automation. */
    authorName: z.string().nullable(),
  })
  .openapi("SentTemplate");

api.openapi(
  createRoute({
    method: "get",
    path: "/api/sent-templates",
    summary: "Which approved templates have already gone out, and to whom",
    description:
      "One flat list of every template that actually left this app, keyed by the contact's handle. This inbox is a shared space — a person sending from the UI and an automation sending on a schedule both land here — so this is the only place that can answer 'has this already been sent?' for BOTH. Anything deciding whether to send should check here first, exactly as a human reads the thread before typing.\n\nFailed sends are excluded: those did not reach anyone, so they are still owed. Ordered newest first.",
    request: {
      query: z.object({
        channel: z.enum(CHANNELS).optional(),
        /** ISO timestamp — only messages at or after this. */
        since: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(SentTemplateSchema) }).openapi("SentTemplateList"),
        "Templates already delivered, newest first",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [
      eq(schema.messages.orgId, org),
      eq(schema.messages.kind, "outbound"),
      sql`${schema.messages.templateName} is not null`,
      // A failed send reached nobody, so it must not suppress a retry.
      sql`coalesce(${schema.messages.status}, '') != 'failed'`,
    ];
    if (q.since) filters.push(sql`${schema.messages.createdAt} >= ${q.since}`);
    if (q.channel) filters.push(eq(schema.conversations.channel, q.channel));

    const rows = await db
      .select({
        handle: schema.contacts.handle,
        channel: schema.conversations.channel,
        templateName: schema.messages.templateName,
        status: schema.messages.status,
        at: schema.messages.createdAt,
        authorName: schema.messages.authorName,
      })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
      .where(and(...filters))
      .orderBy(desc(schema.messages.createdAt))
      .limit(q.limit);

    return c.json({ items: rows.map((r) => ({ ...r, templateName: r.templateName! })) }, 200);
  },
);

/* ------------------------------ channel setup ------------------------------ */

const PhoneSchema = z
  .object({
    id: z.string(),
    displayPhoneNumber: z.string(),
    verifiedName: z.string(),
    /** VERIFIED once Meta has confirmed ownership of the number. */
    codeVerificationStatus: z.string(),
    /** CLOUD_API once registered — anything else can't send. */
    platformType: z.string(),
    qualityRating: z.string(),
    /** True when this number is ready to send. */
    registered: z.boolean(),
    /** True when outbound WhatsApp goes out from this number by default. */
    isDefault: z.boolean(),
  })
  .openapi("Phone");

api.openapi(
  createRoute({
    method: "get",
    path: "/api/whatsapp/phones",
    summary: "Numbers on the connected WhatsApp Business account",
    description:
      "Setup view: which numbers exist and which can actually send. A number only sends once `platformType` is CLOUD_API — until then every queued message fails at the provider, whatever the inbox says.",
    responses: {
      200: jsonRes(
        z.object({
          /** Non-secret diagnostic: confirms which WABA this deployment addresses. */
          wabaId: z.string(),
          items: z.array(PhoneSchema),
        }).openapi("PhoneList"),
        "The numbers",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      424: jsonRes(ErrorSchema, "WhatsApp isn't connected or returned an error"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    try {
      const { client, wabaId } = whatsappBusiness(c.env);
      const result = await client.get(wabaEndpoint(wabaId, "phone_numbers"));
      const phones = metaPhones(result);
      const configured = await readSetting(dbFor(c.env), org, DEFAULT_PHONE_KEY);
      const registered = phones.filter((p) => p.registered);
      // With exactly one registered number it IS the default, implicitly —
      // showing "no default set" there would be a chore with one right answer.
      const effective = configured ?? (registered.length === 1 ? registered[0].id : null);
      return c.json(
        { wabaId, items: phones.map((p) => ({ ...p, isDefault: p.id === effective })) },
        200,
      );
    } catch (err) {
      return c.json({ error: `could not reach whatsapp: ${err}` }, 424);
    }
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/whatsapp/phones/:id/default",
    summary: "Send from this number by default",
    description:
      "Sets the number outbound WhatsApp leaves from. Only a registered number can be the default — an unregistered one cannot send, so making it the default would only produce failures at send time.",
    request: { params: IdParam },
    responses: {
      200: jsonRes(OkSchema, "Default set"),
      401: jsonRes(ErrorSchema, "No org identity"),
      409: jsonRes(ErrorSchema, "That number isn't registered"),
      424: jsonRes(ErrorSchema, "WhatsApp isn't connected or returned an error"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");

    let phones: ProviderPhone[];
    try {
      const { client, wabaId } = whatsappBusiness(c.env);
      phones = metaPhones(await client.get(wabaEndpoint(wabaId, "phone_numbers")));
    } catch (err) {
      return c.json({ error: `could not reach whatsapp: ${err}` }, 424);
    }

    const target = phones.find((p) => p.id === id);
    if (!target?.registered) {
      return c.json({ error: "that number isn't registered, so it can't send" }, 409);
    }

    const db = dbFor(c.env);
    const now = new Date().toISOString();
    await db
      .insert(schema.settings)
      .values({ orgId: org, key: DEFAULT_PHONE_KEY, value: id, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.settings.orgId, schema.settings.key],
        set: { value: id, updatedAt: now },
      });

    return c.json({ ok: true }, 200);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/whatsapp/phones/:id/register",
    summary: "Register a number with the Cloud API",
    description:
      "Completes Meta's registration so the number can send. The PIN is the account's two-step-verification PIN: it is forwarded to Meta and never stored, logged, or returned — losing it means using Meta's own reset flow, not asking us.",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({ pin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits") })
          .openapi("RegisterPhone"),
      ),
    },
    responses: {
      200: jsonRes(OkSchema, "Registered"),
      400: jsonRes(ErrorSchema, "PIN must be 6 digits"),
      401: jsonRes(ErrorSchema, "No org identity"),
      424: jsonRes(ErrorSchema, "Meta rejected the registration"),
    },
  }),
  async (c) => {
    if (!orgId(c)) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const { pin } = c.req.valid("json");
    try {
      // pin is passed straight through; never persisted and never echoed back.
      const { client } = whatsappBusiness(c.env);
      await client.post(objectEndpoint(id, "phone number ID"), {
        messaging_product: "whatsapp",
        pin,
      });
      return c.json({ ok: true }, 200);
    } catch (err) {
      // Meta's message is the useful part ("PIN incorrect", "already
      // registered", rate limits) — pass it on rather than a generic failure.
      return c.json({ error: `${err}`.replace(pin, "******") }, 424);
    }
  },
);

/**
 * Map Meta's phone-number rows, tolerating the broker's nesting. Knows nothing
 * about defaults — that's this app's state, not the provider's.
 */
type ProviderPhone = Omit<z.infer<typeof PhoneSchema>, "isDefault">;

function metaPhones(result: unknown): ProviderPhone[] {
  return unwrapMetaRows(result).rows
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      id: String(p.id ?? ""),
      displayPhoneNumber: String(p.display_phone_number ?? ""),
      verifiedName: String(p.verified_name ?? ""),
      codeVerificationStatus: String(p.code_verification_status ?? "UNKNOWN"),
      platformType: String(p.platform_type ?? "NOT_APPLICABLE"),
      qualityRating: String(p.quality_rating ?? "UNKNOWN"),
      registered: String(p.platform_type ?? "") === "CLOUD_API",
    }))
    .filter((p) => p.id !== "");
}

/* ---------------------------------- outbox --------------------------------- */

api.openapi(
  createRoute({
    method: "get",
    path: "/api/outbox",
    summary: "Queued replies waiting to be sent (agent only)",
    description:
      "Outbound messages with status=queued, oldest first, with the channel and contact handle to send to. After sending each one through the channel, confirm with POST /api/messages/:id/status.\n\nWhen an item carries `template`, send it through the channel's TEMPLATE API with that exact name/language/variables — do NOT send `message.body` as text. The body is the rendered preview for humans; sending it as freeform is what the template exists to avoid and the provider will reject it outside the 24-hour window.\n\nWhen `message.mediaKey` is set the message carries a file: the public URL to send it by is `<app origin>/api/media/<mediaKey>` (it must be sent as a media message, not as text), with `message.mediaType` as the WhatsApp message type and `message.body` as the caption.",
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(25) }),
    },
    responses: {
      200: jsonRes(
        z
          .object({
            items: z.array(
              z
                .object({
                  message: MessageSchema,
                  channel: z.string(),
                  contact: ContactSchema,
                  subject: z.string().nullable(),
                  /**
                   * LinkedIn: true when the contact has never written in this
                   * thread. Send it only to a 1st-degree connection; otherwise
                   * mark it failed ("Not a LinkedIn connection").
                   */
                  opening: z.boolean(),
                  /** Present ⇒ send via the template API, not as text. */
                  template: z
                    .object({
                      name: z.string(),
                      language: z.string(),
                      variables: z.record(z.string()),
                    })
                    .nullable(),
                })
                .openapi("OutboxItem"),
            ),
          })
          .openapi("Outbox"),
        "Queued outbound messages",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { limit } = c.req.valid("query");
    const db = dbFor(c.env);

    const rows = await db
      .select({ message: schema.messages, conv: schema.conversations, contact: schema.contacts })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.status, "queued")))
      .orderBy(asc(schema.messages.createdAt))
      .limit(limit);

    const convs = [...new Map(rows.map((r) => [r.conv.id, r.conv])).values()];
    const windows = await windowsFor(db, convs.filter((cv) => CONNECTION_CHANNELS.has(cv.channel)));

    return c.json(
      {
        items: rows.map((r) => ({
          message: toMessage(r.message),
          channel: r.conv.channel,
          opening: CONNECTION_CHANNELS.has(r.conv.channel) && !windows.get(r.conv.id)?.lastInboundAt,
          subject: r.conv.subject,
          contact: toContact(r.contact),
          template: r.message.templateName
            ? {
                name: r.message.templateName,
                language: r.message.templateLanguage ?? "",
                variables: JSON.parse(r.message.templateVariables ?? "{}") as Record<string, string>,
              }
            : null,
        })),
      },
      200,
    );
  },
);

api.openapi(
  createRoute({
    method: "delete",
    path: "/api/messages/:id",
    summary: "Discard an outbound message that never went out",
    description:
      "Removes a queued or failed outbound message — the draft a human changed their mind about, or one left over from an earlier send path. Deliberately refuses anything already sent: the thread is an audit trail of what the contact actually received, and a delivered message must stay in it.",
    request: { params: IdParam },
    responses: {
      200: jsonRes(OkSchema, "Discarded"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
      409: jsonRes(ErrorSchema, "Already sent — cannot be discarded"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const db = dbFor(c.env);

    const [msg] = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.id, id)))
      .limit(1);
    if (!msg) return c.json({ error: "not found" }, 404);

    if (msg.kind !== "outbound" || (msg.status !== "queued" && msg.status !== "failed")) {
      return c.json(
        { error: "only a queued or failed outbound message can be discarded" },
        409,
      );
    }

    await db.delete(schema.messages).where(eq(schema.messages.id, msg.id));
    return c.json({ ok: true }, 200);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/messages/:id/status",
    summary: "Confirm delivery of a queued reply (agent only)",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({ status: z.enum(["sent", "failed"]), error: z.string().optional() })
          .openapi("DeliveryStatus"),
      ),
    },
    responses: {
      200: jsonRes(OkSchema, "Recorded"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = dbFor(c.env);

    const [row] = await db
      .update(schema.messages)
      .set({ status: body.status, error: body.status === "failed" ? body.error ?? "send failed" : null })
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.id, id)))
      .returning({ id: schema.messages.id, conversationId: schema.messages.conversationId });
    if (!row) return c.json({ error: "not found" }, 404);
    // A failed send needs a human once. Unread is that signal — the thread
    // surfaces the way any new activity does, instead of being pinned forever.
    if (body.status === "failed") {
      await db
        .update(schema.conversations)
        .set({ unread: 1 })
        .where(eq(schema.conversations.id, row.conversationId));
    }
    return c.json({ ok: true }, 200);
  },
);

/* --------------------------- delivery receipts ---------------------------- */

/**
 * How far a message has got. Receipts arrive out of order — a `read` can land
 * before the `delivered` that preceded it — so progress is ranked and only ever
 * moves forward. Without this, a late receipt silently demotes a message the
 * recipient has already read.
 */
const DELIVERY_RANK: Record<string, number> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/**
 * `failed` and `undelivered` are NOT the same thing, and conflating them is a
 * live footgun:
 *
 *   failed       — the send threw when we called the provider. It never left.
 *                  Still owed, so `sent-templates` excludes it and any sweep
 *                  will try again. Correct.
 *   undelivered  — the provider ACCEPTED it, then reported it wasn't delivered
 *                  (number not on WhatsApp, or throttled "to maintain healthy
 *                  ecosystem engagement"). Retrying is wrong: for a dead number
 *                  it's pointless, and for throttling it is precisely the
 *                  behaviour being throttled, which costs quality rating.
 *
 * So `undelivered` still counts as sent for dedupe, and shows red for a human.
 */
const providerStatusToOurs: Record<string, string> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "undelivered",
};

api.openapi(
  createRoute({
    method: "post",
    path: "/api/messages/by-external/:externalId/status",
    summary: "Record a provider delivery receipt against the message it belongs to",
    description:
      "Keyed on the provider's own message id (`externalId`) because a receipt arrives with that and nothing else — the caller has no way to know our id.\n\nA receipt only ever moves a message forward (sent → delivered → read), since receipts arrive out of order. A provider `failed` becomes `undelivered`: the message left us and the provider refused it, which is a different thing from a send that never happened and must not be retried automatically.",
    request: {
      params: z.object({ externalId: z.string().min(1) }),
      body: jsonBody(
        z
          .object({
            status: z.enum(["sent", "delivered", "read", "failed"]),
            error: z.string().optional(),
          })
          .openapi("ProviderReceipt"),
      ),
    },
    responses: {
      200: jsonRes(
        z.object({ ok: z.boolean(), status: z.string(), changed: z.boolean() }).openapi("ReceiptResult"),
        "Recorded (changed=false when the receipt was stale or out of order)",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "No message with that provider id"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { externalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = dbFor(c.env);

    const [msg] = await db
      .select({
        id: schema.messages.id,
        status: schema.messages.status,
        conversationId: schema.messages.conversationId,
      })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.externalId, externalId)))
      .limit(1);
    // A receipt for something we never stored is not an error worth retrying —
    // it usually means the outbound was sent outside this app.
    if (!msg) return c.json({ error: `no message with externalId "${externalId}"` }, 404);

    const next = providerStatusToOurs[body.status];
    const current = msg.status ?? "";

    // Never overwrite a terminal outcome, and never walk backwards.
    const isTerminal = current === "undelivered" || current === "failed";
    const goesBackwards =
      next in DELIVERY_RANK &&
      current in DELIVERY_RANK &&
      DELIVERY_RANK[next] <= DELIVERY_RANK[current];
    if (isTerminal || goesBackwards) {
      return c.json({ ok: true, status: current, changed: false }, 200);
    }

    await db
      .update(schema.messages)
      .set({
        status: next,
        error: next === "undelivered" ? (body.error ?? "the provider did not deliver it") : null,
      })
      .where(eq(schema.messages.id, msg.id));
    // Same contract as a failed send: an undelivered receipt flips the thread
    // unread so it asks for attention once, rather than pinning to the top.
    if (next === "undelivered") {
      await db
        .update(schema.conversations)
        .set({ unread: 1 })
        .where(eq(schema.conversations.id, msg.conversationId));
    }
    return c.json({ ok: true, status: next, changed: true }, 200);
  },
);

export default api;
