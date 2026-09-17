// LinkedIn sync: a schedule on the org's agent that mirrors the LinkedIn inbox
// into this app and sends the LinkedIn messages people queued here.
//
// The app owns the procedure (skills/linkedin-sync/SKILL.md, snapshotted into
// the schedule's task text), the settings and the run history. The agent's own
// scheduler owns the clock: this module creates, changes, pauses and removes
// that one schedule through @clawnify/agents and never runs a timer itself.
//
// Two audiences, two kinds of route:
// - The agent opens and closes runs. Those routes are in the OpenAPI
//   description, because the agent finds them there.
// - People choose the agent, the cadence and on/off. Those routes are left
//   out of the description on purpose: a task must never teach its agent to
//   schedule or dispatch itself. They also refuse any caller that is not a
//   signed-in person.

import { OpenAPIHono, createRoute, z, user, orgId, caller } from "@clawnify/app";
import { createAgents, ClawnifyAgentsError } from "@clawnify/agents";
import { getDB, and, eq, desc, lt } from "@clawnify/db";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import { linkedinSyncSkill } from "./linkedin-skill.gen";

type Env = {
  Bindings: {
    DB: D1Database;
    CLAWNIFY_TOKEN?: string;
    CLAWNIFY_ORG_ID?: string;
    CLAWNIFY_API_URL?: string;
  };
};
type DB = DrizzleD1Database<typeof schema>;
const dbFor = (env: Env["Bindings"]) => getDB(env, { schema }) as DB;

/**
 * When the sync may fire. Office hours by default: a LinkedIn account that
 * reads and sends around the clock looks automated, which is what LinkedIn
 * restricts, and every run spends the agent's credits.
 */
export const SYNC_CADENCES = {
  "workday-hourly": { label: "Every hour, weekdays 8:00–18:00", cron: "0 8-18 * * 1-5" },
  "workday-30m": { label: "Every 30 minutes, weekdays 8:00–18:00", cron: "*/30 8-18 * * 1-5" },
  // Fastest on offer. Each run is a full agent turn, so this costs about six
  // times the hourly option; a run that outlasts the interval makes the next
  // fire stop at its first call (409) rather than overlap.
  "workday-10m": { label: "Every 10 minutes, weekdays 8:00–18:00 (uses the most credits)", cron: "*/10 8-18 * * 1-5" },
  "every-3h": { label: "Every 3 hours, every day", cron: "0 */3 * * *" },
} as const;
type Cadence = keyof typeof SYNC_CADENCES;
const CADENCE_KEYS = Object.keys(SYNC_CADENCES) as [Cadence, ...Cadence[]];

/** A run still open this long never reported back; the next one may start. */
const RUN_STALE_MINUTES = 45;

const SCHEDULE_NAME = "OpenChannels: LinkedIn sync";
const INSTRUCTION_LIMIT = 4000;

/** The schedule's task text: the skill snapshot plus which app to use. */
export function syncBrief(appUrl: string): string {
  const url = new URL(appUrl);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("The app URL must be an HTTPS origin");
  const task = JSON.stringify({ app: "OpenChannels", app_url: url.origin });
  const text = `${linkedinSyncSkill.content}\nSnapshot sha256: ${linkedinSyncSkill.hash}\nTask data: ${task}`;
  if (text.length > INSTRUCTION_LIMIT) {
    throw new Error("The LinkedIn sync skill exceeds the agent's 4,000-character task limit.");
  }
  return text;
}

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const nowIso = () => new Date().toISOString();
const staleBefore = () => new Date(Date.now() - RUN_STALE_MINUTES * 60_000).toISOString();

const ErrorSchema = z.object({ error: z.string() });
const RunSchema = z
  .object({
    id: z.string(),
    status: z.enum(["running", "done", "failed"]),
    mirrored: z.number().int().nullable(),
    sent: z.number().int().nullable(),
    failed: z.number().int().nullable(),
    error: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("LinkedInSyncRun");
type RunRow = typeof schema.linkedinSyncRuns.$inferSelect;
const toRun = (r: RunRow) => ({
  id: r.id,
  status: r.status as "running" | "done" | "failed",
  mirrored: r.mirrored,
  sent: r.sent,
  failed: r.failed,
  error: r.error,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});
const json = <T extends z.ZodTypeAny>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});

const isAgent = (c: Parameters<typeof caller>[0]) => ["agent", "api", "system"].includes(caller(c) ?? "");

export const linkedinSync = new OpenAPIHono<Env>();

/* ------------------------------ agent: runs ------------------------------ */

linkedinSync.openapi(
  createRoute({
    method: "post",
    path: "/api/linkedin-sync/runs",
    summary: "Open a LinkedIn sync run (agent only)",
    description:
      "The first step of every LinkedIn sync task. Generate one UUID and reuse it on retries: the same id returns the same run. 409 means another run is in progress and 410 that sync is off — in both cases stop without touching LinkedIn.",
    request: {
      body: { content: { "application/json": { schema: z.object({ id: z.string().uuid() }) } } },
    },
    responses: {
      200: json(z.object({ run: RunSchema, created: z.literal(false) }), "This run was already opened"),
      201: json(z.object({ run: RunSchema, created: z.literal(true) }), "Run opened"),
      401: json(ErrorSchema, "No org identity"),
      403: json(ErrorSchema, "Only the agent opens runs"),
      409: json(ErrorSchema, "Another LinkedIn sync is running"),
      410: json(ErrorSchema, "LinkedIn sync is off"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    if (!isAgent(c)) return c.json({ error: "Only the agent opens LinkedIn sync runs." }, 403);
    const { id } = c.req.valid("json");
    const db = dbFor(c.env);

    const [mine] = await db
      .select()
      .from(schema.linkedinSyncRuns)
      .where(and(eq(schema.linkedinSyncRuns.id, id), eq(schema.linkedinSyncRuns.orgId, org)))
      .limit(1);
    if (mine) return c.json({ run: toRun(mine), created: false as const }, 200);

    const [sync] = await db
      .select()
      .from(schema.linkedinSync)
      .where(eq(schema.linkedinSync.orgId, org))
      .limit(1);
    if (!sync?.active) return c.json({ error: "LinkedIn sync is off." }, 410);

    // A run that never reported back must not block every later fire.
    const now = nowIso();
    await db
      .update(schema.linkedinSyncRuns)
      .set({
        status: "failed",
        error: `No result reported within ${RUN_STALE_MINUTES} minutes`,
        finishedAt: now,
      })
      .where(
        and(
          eq(schema.linkedinSyncRuns.orgId, org),
          eq(schema.linkedinSyncRuns.status, "running"),
          lt(schema.linkedinSyncRuns.startedAt, staleBefore()),
        ),
      );

    // The partial unique index allows one running row per org, so a second
    // overlapping fire inserts nothing here instead of racing the first.
    const [created] = await db
      .insert(schema.linkedinSyncRuns)
      .values({ id, orgId: org, status: "running", startedAt: now })
      .onConflictDoNothing()
      .returning();
    if (created) return c.json({ run: toRun(created), created: true as const }, 201);

    // Nothing inserted: either this id was taken in a race (possibly by
    // another org, which must not be revealed) or another run is open.
    const [again] = await db
      .select()
      .from(schema.linkedinSyncRuns)
      .where(and(eq(schema.linkedinSyncRuns.id, id), eq(schema.linkedinSyncRuns.orgId, org)))
      .limit(1);
    if (again) return c.json({ run: toRun(again), created: false as const }, 200);
    return c.json({ error: "A LinkedIn sync is already running. Stop without doing anything." }, 409);
  },
);

linkedinSync.openapi(
  createRoute({
    method: "patch",
    path: "/api/linkedin-sync/runs/{id}",
    summary: "Close a LinkedIn sync run (agent only)",
    description:
      "The last step of every LinkedIn sync task, sent once. `done` with the counts, or `failed` with what stopped the run in LinkedIn's own words (a sign-in page, a CAPTCHA, a limit notice).",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              status: z.enum(["done", "failed"]),
              mirrored: z.number().int().min(0).optional(),
              sent: z.number().int().min(0).optional(),
              failed: z.number().int().min(0).optional(),
              error: z.string().max(500).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ run: RunSchema }), "Run closed"),
      400: json(ErrorSchema, "A failed run needs an error"),
      401: json(ErrorSchema, "No org identity"),
      403: json(ErrorSchema, "Only the agent closes runs"),
      404: json(ErrorSchema, "No such run"),
      409: json(ErrorSchema, "The run is already closed"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    if (!isAgent(c)) return c.json({ error: "Only the agent closes LinkedIn sync runs." }, 403);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    if (input.status === "failed" && !input.error?.trim()) {
      return c.json({ error: "Say what stopped the run." }, 400);
    }
    const db = dbFor(c.env);
    const where = and(eq(schema.linkedinSyncRuns.id, id), eq(schema.linkedinSyncRuns.orgId, org));
    const [run] = await db.select().from(schema.linkedinSyncRuns).where(where).limit(1);
    if (!run) return c.json({ error: "not found" }, 404);
    if (run.status !== "running") {
      return c.json({ error: `This run is already ${run.status}.` }, 409);
    }
    const [closed] = await db
      .update(schema.linkedinSyncRuns)
      .set({
        status: input.status,
        mirrored: input.mirrored ?? null,
        sent: input.sent ?? null,
        failed: input.failed ?? null,
        error: input.status === "failed" ? input.error!.trim() : "",
        finishedAt: nowIso(),
      })
      .where(and(where, eq(schema.linkedinSyncRuns.status, "running")))
      .returning();
    if (!closed) return c.json({ error: "This run was closed meanwhile." }, 409);
    return c.json({ run: toRun(closed) }, 200);
  },
);

/* --------------------------- people: settings ---------------------------- */
// Plain routes, not openapi(): see the header.

class ControlError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503, readonly outcomeUnknown = false) {
    super(message);
  }
}

const personOnly = (c: Parameters<typeof user>[0]) => {
  const org = orgId(c);
  if (!org) throw new ControlError("unauthorized", 403);
  if (!user(c)) throw new ControlError("Only a signed-in person can change LinkedIn sync.", 403);
  return org;
};

const agentsError = (e: unknown): ControlError =>
  e instanceof ClawnifyAgentsError && e.code === "not_configured"
    ? new ControlError(
        "This app can't reach your agents yet. Deploy it on Clawnify (or redeploy it) and try again.",
        503,
      )
    : e instanceof ClawnifyAgentsError
    ? new ControlError(
        e.outcomeUnknown
          ? `${e.message}. It may have gone through: refresh before trying again.`
          : e.message,
        503,
        e.outcomeUnknown,
      )
    : new ControlError(e instanceof Error ? e.message : "The agent's scheduler could not be reached.", 503);

linkedinSync.onError((e, c) => {
  if (e instanceof ControlError) {
    return c.json({ error: e.message, outcome_unknown: e.outcomeUnknown }, e.status);
  }
  throw e;
});

async function readSync(db: DB, org: string) {
  const [row] = await db.select().from(schema.linkedinSync).where(eq(schema.linkedinSync.orgId, org)).limit(1);
  return row ?? null;
}

async function recordScheduleError(db: DB, org: string, message: string | null) {
  await db
    .update(schema.linkedinSync)
    .set({ scheduleError: message, updatedAt: nowIso() })
    .where(eq(schema.linkedinSync.orgId, org));
}

async function present(c: { env: Env["Bindings"] }, db: DB, org: string) {
  const sync = await readSync(db, org);
  const runs = await db
    .select()
    .from(schema.linkedinSyncRuns)
    .where(eq(schema.linkedinSyncRuns.orgId, org))
    .orderBy(desc(schema.linkedinSyncRuns.startedAt))
    .limit(10);
  // Best effort: the settings page still renders when the scheduler is down.
  let schedule: { nextRunAt: string | null; enabled: boolean } | null = null;
  if (sync?.scheduleId) {
    try {
      const { schedule: s } = await createAgents(c.env).schedules.get(sync.serverId, sync.scheduleId);
      schedule = { nextRunAt: s.state.next_run_at, enabled: s.enabled };
    } catch {
      schedule = null;
    }
  }
  return {
    sync: sync
      ? {
          serverId: sync.serverId,
          cadence: sync.cadence,
          timezone: sync.timezone,
          active: sync.active === 1,
          scheduled: !!sync.scheduleId,
          scheduleError: sync.scheduleError,
          nextRunAt: schedule?.nextRunAt ?? null,
        }
      : null,
    runs: runs.map(toRun),
    cadences: Object.entries(SYNC_CADENCES).map(([key, v]) => ({ key, label: v.label })),
  };
}

linkedinSync.get("/api/linkedin-sync", async (c) => {
  const org = personOnly(c);
  return c.json(await present(c, dbFor(c.env), org));
});

linkedinSync.get("/api/linkedin-sync/agents", async (c) => {
  personOnly(c);
  try {
    const { servers } = await createAgents(c.env).list({ limit: 50 });
    return c.json({ agents: servers });
  } catch (e) {
    throw agentsError(e);
  }
});

const SettingsInput = z.object({
  serverId: z.string().min(1),
  cadence: z.enum(CADENCE_KEYS),
  timezone: z.string().min(1).refine(validTimezone, "Unknown time zone"),
  active: z.boolean(),
});

linkedinSync.put("/api/linkedin-sync", async (c) => {
  const org = personOnly(c);
  const parsed = SettingsInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ControlError(parsed.error.issues.map((i) => i.message).join(" "), 400);
  const input = parsed.data;
  const db = dbFor(c.env);
  const agents = createAgents(c.env);
  let row = await readSync(db, org);

  // Moving to another agent: the old schedule must be gone before a new one
  // exists, or both would fire. If removing it fails, stop here.
  if (row?.scheduleId && row.serverId !== input.serverId) {
    try {
      await agents.schedules.delete(row.serverId, row.scheduleId);
    } catch (e) {
      if (!(e instanceof ClawnifyAgentsError && e.status === 404)) {
        await recordScheduleError(db, org, `Could not remove the schedule from the previous agent: ${(e as Error).message}`);
        throw agentsError(e);
      }
    }
    await db
      .update(schema.linkedinSync)
      .set({ scheduleId: null, setupId: crypto.randomUUID(), updatedAt: nowIso() })
      .where(eq(schema.linkedinSync.orgId, org));
    row = await readSync(db, org);
  }

  // Record the person's choice first. Turning sync off takes effect here even
  // if the scheduler is unreachable: a run that starts now gets a 410.
  if (!row) {
    await db.insert(schema.linkedinSync).values({
      orgId: org,
      serverId: input.serverId,
      cadence: input.cadence,
      timezone: input.timezone,
      active: input.active ? 1 : 0,
      setupId: crypto.randomUUID(),
      updatedAt: nowIso(),
    });
  } else {
    await db
      .update(schema.linkedinSync)
      .set({
        serverId: input.serverId,
        cadence: input.cadence,
        timezone: input.timezone,
        active: input.active ? 1 : 0,
        updatedAt: nowIso(),
      })
      .where(eq(schema.linkedinSync.orgId, org));
  }
  row = (await readSync(db, org))!;

  const trigger = { kind: "cron" as const, expr: SYNC_CADENCES[input.cadence].cron, tz: input.timezone };
  const text = syncBrief(new URL(c.req.url).origin);
  try {
    if (row.scheduleId) {
      // The text is rewritten on every save, so a newer skill reaches the agent.
      await agents.schedules.update(row.serverId, row.scheduleId, { trigger, text, enabled: input.active });
    } else if (input.active) {
      const { schedule } = await agents.schedules.create(
        row.serverId,
        { name: SCHEDULE_NAME, trigger, text },
        { idempotencyKey: `openchannels-linkedin-sync:${row.setupId}` },
      );
      await db
        .update(schema.linkedinSync)
        .set({ scheduleId: schedule.id, updatedAt: nowIso() })
        .where(eq(schema.linkedinSync.orgId, org));
      // Turned off while the create was in flight: keep the new schedule paused.
      const latest = await readSync(db, org);
      if (latest && latest.active !== 1) await agents.schedules.pause(row.serverId, schedule.id);
    }
    await recordScheduleError(db, org, null);
  } catch (e) {
    await recordScheduleError(db, org, (e as Error).message);
    throw agentsError(e);
  }
  return c.json(await present(c, db, org));
});

linkedinSync.delete("/api/linkedin-sync", async (c) => {
  const org = personOnly(c);
  const db = dbFor(c.env);
  const row = await readSync(db, org);
  if (!row) return c.json({ ok: true });
  // Off first, so nothing new starts while the schedule is being removed.
  await db.update(schema.linkedinSync).set({ active: 0, updatedAt: nowIso() }).where(eq(schema.linkedinSync.orgId, org));
  if (row.scheduleId) {
    try {
      await createAgents(c.env).schedules.delete(row.serverId, row.scheduleId);
    } catch (e) {
      if (!(e instanceof ClawnifyAgentsError && e.status === 404)) {
        await recordScheduleError(db, org, `Could not remove the schedule: ${(e as Error).message}`);
        throw agentsError(e);
      }
    }
  }
  await db.delete(schema.linkedinSync).where(eq(schema.linkedinSync.orgId, org));
  return c.json({ ok: true });
});

linkedinSync.post("/api/linkedin-sync/run-now", async (c) => {
  const org = personOnly(c);
  const body = z.object({ id: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ControlError("Send a request id.", 400);
  const db = dbFor(c.env);
  const row = await readSync(db, org);
  if (!row?.active) throw new ControlError("Turn LinkedIn sync on first.", 409);
  try {
    await createAgents(c.env).dispatch({
      server_id: row.serverId,
      instruction: syncBrief(new URL(c.req.url).origin),
      // The browser keeps this id for its retries, so a double click or a
      // retried request never dispatches a second task.
      idempotency_key: `openchannels-linkedin-sync-now:${body.data.id}`,
    });
  } catch (e) {
    throw agentsError(e);
  }
  return c.json({ dispatched: true }, 202);
});
