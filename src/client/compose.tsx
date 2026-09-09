import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, RefreshCw, Search, X } from "lucide-react";
import type { Conversation, Profile, ProfileSource, Template } from "./api";
import {
  getProfileSource,
  listTemplates,
  refreshTemplates,
  searchProfiles,
  sendTemplate,
  startConversation,
} from "./api";
import { CHANNELS, ChannelMark, SectionLabel, channelMeta } from "./ui";

/** Substitutes filled values into a template body for the live preview. */
const renderPreview = (body: string, values: Record<string, string>) =>
  body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, token: string) =>
    values[token]?.trim() ? values[token] : whole,
  );

/* ---------------------------------- dialog --------------------------------- */

/**
 * Hand-rolled to match the shadcn Dialog contract DESIGN.md specifies (title,
 * body form, right-aligned footer with Cancel before the single primary) —
 * this app carries no component library. Esc and the backdrop both cancel, so
 * every dismissal path resolves the same way.
 */
function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/25 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface shadow-float"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight">{title}</h2>
            {description ? <p className="mt-1 text-[0.8125rem] leading-[1.45] text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="btn btn-ghost -mr-1 -mt-0.5 size-8 shrink-0 px-0"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------ template picker ---------------------------- */

/**
 * Pick an approved template and fill its {{placeholders}}. The preview updates
 * as values are typed, so the exact text going out is reviewable before send.
 */
export function TemplateComposer({
  conversation,
  fromPhoneNumberId,
  onSent,
}: {
  conversation: Conversation;
  /** Which number to send from; null lets the org default apply. */
  fromPhoneNumberId?: string | null;
  onSent: () => void;
}) {
  const [search, setSearch] = useState("");
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selected, setSelected] = useState<Template | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(debounce.current);
  }, [search]);

  const load = useCallback(async () => {
    const { items } = await listTemplates({
      channel: conversation.channel,
      search: debounced || undefined,
      limit: 25,
    });
    setTemplates(items);
  }, [conversation.channel, debounced]);

  useEffect(() => {
    setTemplates(null);
    load().catch(() => setTemplates([]));
  }, [load]);

  const missing = useMemo(
    () => (selected?.variables ?? []).filter((t) => !values[t]?.trim()),
    [selected, values],
  );

  function choose(template: Template) {
    setSelected(template);
    setValues({});
    setError(null);
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await refreshTemplates(conversation.channel);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the provider.");
    } finally {
      setRefreshing(false);
    }
  }

  async function submit() {
    if (!selected || missing.length > 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendTemplate(
        conversation.id,
        { name: selected.name, language: selected.language, variables: values },
        fromPhoneNumberId ?? undefined,
      );
      setSelected(null);
      setValues({});
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the template.");
    } finally {
      setSending(false);
    }
  }

  if (selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <SectionLabel>Template</SectionLabel>
            <p className="mt-1.5 truncate font-mono text-[0.8125rem] text-foreground">{selected.name}</p>
          </div>
          <button
            type="button"
            onClick={() => setSelected(null)}
            aria-label="Choose a different template"
            className="btn btn-secondary"
          >
            Change
          </button>
        </div>

        {selected.variables.length > 0 ? (
          <div className="space-y-2.5">
            <SectionLabel>Variables</SectionLabel>
            {selected.variables.map((token) => (
              <div key={token} className="space-y-1">
                <label
                  htmlFor={`tpl-var-${token}`}
                  className="section-label block font-mono"
                >
                  {`{{${token}}}`}
                </label>
                <input
                  id={`tpl-var-${token}`}
                  value={values[token] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [token]: e.target.value }))}
                  placeholder={`Value for {{${token}}}`}
                  className="input text-sm"
                />
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <SectionLabel>Preview</SectionLabel>
          <div className="rounded-md bg-sunken px-3.5 py-2.5">
            <p className="whitespace-pre-wrap text-sm leading-normal text-foreground">
              {renderPreview(selected.bodyText, values)}
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-relaxed text-muted">
            {missing.length > 0
              ? `Fill ${missing.length} more ${missing.length === 1 ? "value" : "values"} to send.`
              : "Sent by your agent as an approved template."}
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={sending || missing.length > 0}
            aria-label="Queue template for sending"
            className="btn btn-primary"
          >
            {sending ? "Queueing…" : "Send template"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search approved templates…"
            aria-label="Search approved templates"
            className="input pl-8 text-sm"
          />
        </div>
        {templates && templates.length > 0 ? (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh templates from the provider"
            className="btn btn-secondary"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger">
          {error}
        </p>
      ) : null}

      {templates === null ? (
        <p className="py-6 text-center text-sm text-muted">Loading templates…</p>
      ) : templates.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm leading-relaxed text-muted">
            {debounced
              ? "No approved template matches that search."
              : `No approved ${channelMeta(conversation.channel).label} templates here yet. Pull them from your connected account.`}
          </p>
          {debounced ? null : (
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh templates from the provider"
              className="btn btn-primary mx-auto mt-3"
            >
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              {refreshing ? "Refreshing…" : "Refresh templates"}
            </button>
          )}
        </div>
      ) : (
        <div className="card max-h-64 divide-y divide-border overflow-y-auto p-0">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => choose(t)}
              aria-label={`Use template ${t.name}`}
              className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-sunken"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-foreground">
                  {t.name}
                </span>
                <span className="chip">{t.language}</span>
                <span className="chip">{t.category}</span>
              </div>
              <span className="line-clamp-2 text-[0.8125rem] leading-[1.45] text-muted">{t.bodyText}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------- new conversation flow -------------------------- */

/**
 * Opens a thread with someone the inbox hasn't heard from. Creating the thread
 * and writing the first message are deliberately separate: once the thread
 * exists the normal composer applies the send-window rule, so there is one
 * send path rather than two that could disagree.
 */
export function NewConversationDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (conversation: Conversation) => void;
}) {
  const [channel, setChannel] = useState("whatsapp");
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The org's people app, when one is configured. Absent is the normal case
  // for a fresh install, and everything below degrades to typing a handle.
  const [source, setSource] = useState<ProfileSource | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Profile | null>(null);

  useEffect(() => {
    getProfileSource()
      .then((r) => setSource(r.source))
      .catch(() => setSource(null));
  }, []);

  /** Which of a person's fields is the address on this channel. */
  const addressFor = useCallback(
    (p: Profile) => (channel === "email" ? p.email : p.phone ?? p.email),
    [channel],
  );

  useEffect(() => {
    if (!source || picked) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    // Debounced: this is a proxied call into another app, not a local filter.
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      searchProfiles(q)
        .then((r) => live && setResults(r.items))
        .catch(() => live && setResults([]))
        .finally(() => live && setSearching(false));
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, source, picked]);

  function pick(p: Profile) {
    setPicked(p);
    setHandle(addressFor(p) ?? "");
    // Their real name from the CRM is a curated name, not a provider guess —
    // it belongs in `name`. Only fills a blank field; never overwrites typing.
    setName((current) => current || p.name || "");
    setQuery("");
    setResults([]);
  }

  /**
   * Editing the address by hand un-picks, so a link can never end up attached
   * to someone else's number — but only when there was a known address to
   * diverge *from*. Plenty of records have no phone on file; typing one for
   * them is supplying the missing address, not retargeting the conversation,
   * and dropping the link there would silently discard the pick.
   */
  function editHandle(value: string) {
    setHandle(value);
    const known = picked ? addressFor(picked) : null;
    if (picked && known && value !== known) setPicked(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await startConversation({
        channel,
        handle: handle.trim(),
        name: name.trim() || undefined,
        subject: channel === "email" && subject.trim() ? subject.trim() : undefined,
        linked:
          picked?.ref && source ? { appId: source.appId, ref: picked.ref } : undefined,
      });
      onOpened(conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the conversation.");
      setBusy(false);
    }
  }

  const handleLabel =
    channel === "email" ? "Email address" : channel === "whatsapp" || channel === "sms" ? "Phone number" : "Username or ID";

  return (
    <Dialog
      title="New conversation"
      description="Opens the thread so you can write first."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="space-y-1.5">
            <SectionLabel>Channel</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(CHANNELS).map((ch) => {
                const active = ch === channel;
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setChannel(ch)}
                    aria-pressed={active}
                    aria-label={`Send on ${channelMeta(ch).label}`}
                    className={`btn ${active ? "btn-secondary" : "btn-ghost"}`}
                  >
                    <ChannelMark channel={ch} className="size-4" />
                    {channelMeta(ch).label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2.5">
            <SectionLabel>Contact</SectionLabel>

            {source ? (
              picked ? (
                <div className="flex items-center gap-2 rounded-sm bg-sunken px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.8125rem] font-medium text-foreground">
                      {picked.name || picked.ref}
                    </p>
                    <p className="truncate text-[0.6875rem] text-muted">
                      {addressFor(picked) || "no address on file"} ·{" "}
                      {source.label ?? "people app"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPicked(null)}
                    aria-label="Unlink this person"
                    className="btn btn-ghost size-7 shrink-0 px-0 hover:bg-surface"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <label
                    htmlFor="nc-person"
                    className="section-label block"
                  >
                    Find someone in {source.label ?? "your records"}
                  </label>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
                      aria-hidden
                    />
                    <input
                      id="nc-person"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                      placeholder="Search by name, phone or email"
                      className="input pl-8 text-sm"
                    />
                  </div>
                  {query.trim() && !searching && results.length === 0 ? (
                    <p className="text-xs leading-relaxed text-muted">
                      Nobody found — type the {handleLabel.toLowerCase()} below instead.
                    </p>
                  ) : null}
                  {results.length ? (
                    <ul className="max-h-44 overflow-y-auto rounded-sm bg-surface shadow-edge">
                      {results.map((p) => (
                        <li key={p.ref}>
                          <button
                            type="button"
                            onClick={() => pick(p)}
                            className="flex w-full flex-col items-start gap-0.5 border-b border-border px-2.5 py-1.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-sunken"
                          >
                            <span className="text-[0.8125rem] font-medium text-foreground">
                              {p.name || p.ref}
                            </span>
                            <span className="text-[0.6875rem] text-muted">
                              {addressFor(p) || "no address on file"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )
            ) : null}

            <div className="space-y-1">
              <label htmlFor="nc-handle" className="section-label block">
                {handleLabel}
              </label>
              <input
                id="nc-handle"
                value={handle}
                onChange={(e) => editHandle(e.target.value)}
                required
                autoFocus={!source}
                inputMode={channel === "whatsapp" || channel === "sms" ? "tel" : "text"}
                placeholder={channel === "email" ? "person@company.com" : "+31612345678"}
                className="input text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="nc-name" className="section-label block">
                Their name (optional)
              </label>
              <input
                id="nc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kara Finley"
                className="input text-sm"
              />
              {/* "Display name" is Meta's term for the BUSINESS name recipients
                  see — using it here read as though this set our own. */}
              <p className="text-xs leading-relaxed text-muted">
                Only labels this thread in your inbox. Leave it blank and their
                WhatsApp profile name fills it in once they reply.
              </p>
            </div>
            {channel === "email" ? (
              <div className="space-y-1">
                <label htmlFor="nc-subject" className="section-label block">
                  Subject
                </label>
                <input
                  id="nc-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Following up on your quote"
                  className="input text-sm"
                />
              </div>
            ) : null}
          </div>

          {channel === "whatsapp" ? (
            <p className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-muted">
              <FileText className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                WhatsApp only opens a new conversation with a template Meta has approved. You'll pick one
                next.
              </span>
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || handle.trim() === ""}
            aria-label="Open the conversation"
            className="btn btn-primary"
          >
            {busy ? "Opening…" : "Continue"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
