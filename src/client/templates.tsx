import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, FileText, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Template } from "./api";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  listTemplates,
  refreshTemplates,
} from "./api";
import { SectionLabel } from "./ui";

/**
 * Read and edit the approved template catalogue.
 *
 * Deliberately not part of the send composer. Editing a template is the one
 * action that makes it *unsendable* — the provider re-reviews on every edit —
 * so putting it beside the Send button invites someone to discover that while
 * trying to message a person who is waiting.
 */

const STATUS_TONE: Record<string, string> = {
  APPROVED: "badge-success",
  PENDING: "badge-warning",
  REJECTED: "badge-danger",
  PAUSED: "badge-warning",
};

const STATUS_MEANING: Record<string, string> = {
  APPROVED: "In the send picker.",
  PENDING: "In review with the provider — not sendable until it comes back.",
  REJECTED: "The provider refused it. Edit and resubmit.",
  PAUSED: "The provider suspended it, usually for quality.",
};

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={tone ? `badge ${tone}` : "chip rounded-full"}
      title={STATUS_MEANING[status] ?? status}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

/** `{{1}}` … in order of first appearance — the shape a sender must match. */
function placeholders(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) seen.add(m[1]);
  return [...seen];
}

/**
 * The example values already on a template.
 *
 * The provider needs one per variable on every write, so an edit that sent none
 * would strip them — and a template with variables and no examples is one the
 * provider can no longer categorise. These prefill the inputs so a body-only
 * edit keeps what was approved.
 */
function storedSamples(components: unknown[]): string[] {
  for (const comp of components) {
    const c = comp as { type?: string; example?: Record<string, unknown> };
    if (c?.type?.toUpperCase() !== "BODY" || !c.example) continue;
    const positional = c.example.body_text;
    if (Array.isArray(positional)) {
      const first = positional[0];
      return (Array.isArray(first) ? first : positional).map(String);
    }
    const named = c.example.body_text_named_params;
    if (Array.isArray(named)) {
      return named.map((p) => String((p as { example?: unknown })?.example ?? ""));
    }
  }
  return [];
}

/** One input per variable — what the provider will see as the example send. */
function SampleFields({
  variables,
  values,
  onChange,
}: {
  variables: string[];
  values: string[];
  onChange: (next: string[]) => void;
}) {
  if (variables.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Example values — the provider reviews the message with these filled in, and refuses a
        template whose variables have none.
      </p>
      {variables.map((v, i) => (
        <label key={v} className="flex items-center gap-2">
          <span className="w-24 shrink-0 font-mono text-xs text-muted">{`{{${v}}}`}</span>
          <input
            className="input min-w-0 flex-1 text-sm"
            value={values[i] ?? ""}
            placeholder="e.g. Lexie"
            onChange={(e) => {
              const next = [...values];
              next[i] = (e.target as HTMLInputElement).value;
              onChange(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

function Editor({
  template,
  onDone,
  onDeleted,
}: {
  template: Template;
  onDone: (t: Template) => void;
  onDeleted: (id: string) => void;
}) {
  const [draft, setDraft] = useState(template.bodyText);
  const [samples, setSamples] = useState<string[]>(() => storedSamples(template.components));
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const before = placeholders(template.bodyText);
  const after = placeholders(draft);
  // A variable added mid-edit has no example yet, and the provider rejects the
  // write rather than approving a template it cannot read.
  const missingSample = after.some((_, i) => !(samples[i] ?? "").trim());
  // The count is what the provider validates a send against, so it is the
  // thing worth shouting about — renaming {{1}} to {{a}} is cosmetic, dropping
  // one is a broken send for every automation already using this template.
  const countChanged = before.length !== after.length;
  const dirty = draft.trim() !== template.bodyText.trim() && draft.trim().length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await editTemplate(template.id, draft, samples.slice(0, after.length));
      onDone(res.template);
    } catch (e) {
      setError((e as Error)?.message || "The provider rejected the edit");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteTemplate(template.id);
      onDeleted(template.id);
    } catch (e) {
      setError((e as Error)?.message || "The provider refused the delete");
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <textarea
        className="input min-h-[8rem] font-mono text-sm"
        value={draft}
        onChange={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        spellCheck
      />

      <p className="text-xs text-muted">
        Variables: {after.length === 0 ? "none" : after.map((v) => `{{${v}}}`).join(" ")}
      </p>

      <SampleFields variables={after} values={samples} onChange={setSamples} />

      {countChanged && (
        <div className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This changes the number of variables from <strong>{before.length}</strong> to{" "}
            <strong>{after.length}</strong>. Anything already sending this template supplies{" "}
            {before.length} and will start failing — the provider rejects a send whose variable
            count doesn't match. Check what uses it before saving.
          </span>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-md bg-sunken px-3 py-2 text-xs leading-relaxed text-muted">
        <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Saving submits this to the provider for review. It leaves the send picker until they
          approve it again — usually minutes, sometimes a day.
        </span>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saving || deleting || missingSample}
          onClick={save}
        >
          {saving ? "Submitting…" : "Submit for review"}
        </button>

        {/* Two steps, and the second one says what it costs. A delete here is
            not undoable and takes the name out of use for a month. */}
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleting}
              onClick={remove}
            >
              {deleting ? "Deleting…" : "Delete permanently"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
            <span className="text-xs text-danger">
              This can't be undone, and the provider blocks the name{" "}
              <span className="font-mono">{template.name}</span> for 30 days.
            </span>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-danger ml-auto"
            disabled={saving}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** Categories the provider accepts, in the order a person is likely to want. */
const CATEGORIES = [
  { value: "UTILITY", hint: "Order updates, appointments, account notices." },
  { value: "MARKETING", hint: "Promotions and anything the contact opted in to." },
  { value: "AUTHENTICATION", hint: "One-time codes only." },
] as const;

/**
 * The category the provider assigned, on every row. Neutral tone on purpose:
 * unlike status, no category is a problem state — but which one a template
 * landed in decides its pricing and delivery rules, so it must be visible
 * without opening the editor.
 */
function CategoryPill({ category }: { category: string }) {
  return (
    <span
      className="chip rounded-full"
      title={CATEGORIES.find((c) => c.value === category)?.hint ?? category}
    >
      {category.charAt(0) + category.slice(1).toLowerCase()}
    </span>
  );
}

/**
 * Create a template.
 *
 * The name and language are permanent: the provider keys the template on them,
 * a name cannot be renamed, and a deleted name is unusable for 30 days. So they
 * are collected once, here, and never offered as editable fields afterwards.
 */
function NewTemplate({ onCreated, onCancel }: { onCreated: (t: Template) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<string>("UTILITY");
  const [bodyText, setBodyText] = useState("");
  const [samples, setSamples] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variables = placeholders(bodyText);
  // The provider's own rule, checked here so a typo fails before a round trip.
  const nameOk = /^[a-z0-9_]+$/.test(name);
  const ready =
    nameOk &&
    language.trim().length >= 2 &&
    bodyText.trim().length > 0 &&
    variables.every((_, i) => (samples[i] ?? "").trim());

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await createTemplate({
        channel: "whatsapp",
        name,
        language: language.trim(),
        category,
        bodyText,
        samples: samples.slice(0, variables.length),
      });
      onCreated(created);
    } catch (e) {
      setError((e as Error)?.message || "The provider rejected the template");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card mb-4 space-y-3 p-3">
      <div className="flex flex-wrap gap-2">
        <label className="min-w-[14rem] flex-1">
          <span className="section-label mb-1 block">Name — permanent, and lowercase</span>
          <input
            className="input font-mono text-sm"
            value={name}
            placeholder="appointment_reminder_v1"
            onChange={(e) =>
              setName((e.target as HTMLInputElement).value.toLowerCase().replace(/\s+/g, "_"))
            }
          />
        </label>
        <label className="w-28">
          <span className="section-label mb-1 block">Language</span>
          <input
            className="input font-mono text-sm"
            value={language}
            placeholder="en_US"
            onChange={(e) => setLanguage((e.target as HTMLInputElement).value)}
          />
        </label>
        <label className="w-44">
          <span className="section-label mb-1 block">Category</span>
          <select
            className="input text-sm"
            value={category}
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-muted">
        {CATEGORIES.find((c) => c.value === category)?.hint} The provider re-decides this from the
        copy and its verdict wins — and it cannot be changed later, so the template would have to be
        replaced.
      </p>

      <textarea
        className="input min-h-[6rem] font-mono text-sm"
        value={bodyText}
        placeholder={"Hi {{1}}, your table for {{2}} is confirmed."}
        onChange={(e) => setBodyText((e.target as HTMLTextAreaElement).value)}
        spellCheck
      />

      <SampleFields variables={variables} values={samples} onChange={setSamples} />

      {name && !nameOk && (
        <p className="text-xs text-danger">
          Lowercase letters, digits and underscores only — the provider rejects anything else.
        </p>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || saving}
          onClick={submit}
        >
          {saving ? "Submitting…" : "Submit for review"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The template catalogue, as a panel inside WhatsApp setup.
 *
 * It lives there and not in its own nav entry because a template belongs to one
 * provider, not to the inbox: the name rules, the categories, the review, the
 * 30-day hold on a deleted name are all WhatsApp's. A screen called "Templates"
 * beside the conversation filters would have to answer "whose?" on every row,
 * and would go on lying the moment a second channel gained templates of its own.
 */
export function TemplatesPanel() {
  const [items, setItems] = useState<Template[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    // Every status, not just APPROVED: a template in review has to be visible,
    // or an edit looks like the template vanished.
    const { items } = await listTemplates({ channel: "whatsapp", status: "all", limit: 100 });
    setItems(items);
  }, []);

  useEffect(() => {
    load().catch(() => setItems([]));
  }, [load]);

  const resync = async () => {
    setRefreshing(true);
    try {
      await refreshTemplates("whatsapp");
      await load();
    } catch {
      /* the button is a convenience; the list is still whatever we last knew */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <FileText className="size-4" aria-hidden />
        <SectionLabel>Message templates · {items?.length ?? 0}</SectionLabel>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="btn btn-secondary ml-auto"
        >
          <Plus className="size-3.5" aria-hidden />
          New template
        </button>
        <button
          type="button"
          onClick={resync}
          disabled={refreshing}
          className="btn btn-secondary"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          {refreshing ? "Syncing…" : "Sync from provider"}
        </button>
      </div>

      <div className="mt-3">
        <p className="mb-4 max-w-[70ch] text-xs leading-relaxed text-muted">
          WhatsApp owns this catalogue — these are mirrored from it, and both an edit and a new
          template are submitted back for review rather than applied here. Approved templates are
          the only ones the send picker offers.
        </p>

        {creating && (
          <NewTemplate
            onCancel={() => setCreating(false)}
            onCreated={(t) => {
              setItems((cur) => [t, ...(cur ?? [])]);
              setJustSaved(t.id);
              setCreating(false);
            }}
          />
        )}

        {items === null ? (
          <p className="text-sm text-muted">Loading templates…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">
            No templates yet. Sync from the provider, or create one in their console.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((t) => (
              <li key={t.id} className="card p-3">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpenId(openId === t.id ? null : t.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[0.8125rem] font-medium">{t.name}</span>
                      <StatusPill status={t.status} />
                      <CategoryPill category={t.category} />
                      {justSaved === t.id && (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <Check className="size-3" aria-hidden /> submitted
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-muted">
                      {t.bodyText}
                    </p>
                  </button>
                </div>

                {openId === t.id && (
                  <Editor
                    template={t}
                    onDone={(updated) => {
                      setItems((cur) =>
                        (cur ?? []).map((x) => (x.id === updated.id ? updated : x)),
                      );
                      setJustSaved(updated.id);
                      setOpenId(null);
                    }}
                    onDeleted={(deletedId) => {
                      setItems((cur) => (cur ?? []).filter((x) => x.id !== deletedId));
                      setOpenId(null);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
