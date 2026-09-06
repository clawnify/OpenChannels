import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CircleDashed, Inbox, Menu, PenLine, Search, Settings, TriangleAlert, UserCheck } from "lucide-react";
import type { Conversation, SearchHit, Stats } from "./api";
import {
  contactLabel,
  getStats,
  listConversations,
  searchMessages,
  getConversation,
  patchConversation,
  startConversation,
} from "./api";
import { NewConversationDialog } from "./compose";
import { WhatsAppSetup } from "./setup";
import { ThreadPane } from "./thread";
import { Avatar, CHANNELS, ChannelMark, Eyebrow, channelMeta, timeAgo } from "./ui";

const POLL_MS = 5000;
const PAGE_SIZE = 50;

/** Sidebar filter: the whole inbox, one channel, or the closed archive. */
type Filter =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "unassigned" }
  | { kind: "channel"; channel: string }
  | { kind: "closed" }
  | { kind: "setup" };

function SidebarRow({
  active,
  onClick,
  icon,
  label,
  count,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[0.4375rem] text-sm transition-colors duration-150 ${
        active
          ? "bg-primary/12 font-semibold text-primary"
          : "text-foreground hover:bg-sunken"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && count > 0 ? (
        <span
          className={`text-xs tabular-nums ${active ? "text-primary" : "text-muted"}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Sidebar({
  stats,
  filter,
  setFilter,
}: {
  stats: Stats | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  const channelCount = (ch: string) => stats?.channels.find((c) => c.channel === ch)?.open ?? 0;
  // Only channels that have (or had) conversations show up — plus none-yet hint.
  const activeChannels = Object.keys(CHANNELS).filter((ch) => channelCount(ch) > 0);

  return (
    <aside className="flex w-[16.25rem] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Inbox className="size-4 text-foreground" aria-hidden />
        <span className="text-base font-semibold">Channels</span>
        {stats && stats.queued > 0 ? (
          <span className="ml-auto rounded-full border border-warning/30 bg-warning-tint px-2 py-0.5 text-xs text-warning tabular-nums">
            {stats.queued} queued
          </span>
        ) : null}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        <div className="space-y-1">
          <div className="px-2.5 pb-1.5 pt-1">
            <Eyebrow>Inbox</Eyebrow>
          </div>
          <SidebarRow
            active={filter.kind === "all"}
            onClick={() => setFilter({ kind: "all" })}
            icon={<Inbox className="size-4" aria-hidden />}
            label="All open"
            count={stats?.totalOpen}
            ariaLabel="Show all open conversations"
          />
          <SidebarRow
            active={filter.kind === "mine"}
            onClick={() => setFilter({ kind: "mine" })}
            icon={<UserCheck className="size-4" aria-hidden />}
            label="Mine"
            count={stats?.mine}
            ariaLabel="Show conversations assigned to you"
          />
          <SidebarRow
            active={filter.kind === "unassigned"}
            onClick={() => setFilter({ kind: "unassigned" })}
            icon={<CircleDashed className="size-4" aria-hidden />}
            label="Unassigned"
            count={stats?.unassigned}
            ariaLabel="Show unassigned conversations"
          />
        </div>

        <div className="space-y-1">
          <div className="px-2.5 pb-1.5">
            <Eyebrow>Channels</Eyebrow>
          </div>
          {activeChannels.length === 0 ? (
            <p className="px-2.5 py-1 text-xs leading-relaxed text-muted">
              No channels yet. Your agent adds one the first time it mirrors a message.
            </p>
          ) : (
            activeChannels.map((ch) => {
              const meta = channelMeta(ch);
              return (
                <SidebarRow
                  key={ch}
                  active={filter.kind === "channel" && filter.channel === ch}
                  onClick={() => setFilter({ kind: "channel", channel: ch })}
                  icon={<ChannelMark channel={ch} className="size-4" />}
                  label={meta.label}
                  count={channelCount(ch)}
                  ariaLabel={`Show ${meta.label} conversations`}
                />
              );
            })
          )}
        </div>

        <div className="space-y-1">
          <div className="px-2.5 pb-1.5">
            <Eyebrow>Views</Eyebrow>
          </div>
          <SidebarRow
            active={filter.kind === "closed"}
            onClick={() => setFilter({ kind: "closed" })}
            icon={<Archive className="size-4" aria-hidden />}
            label="Closed"
            ariaLabel="Show closed conversations"
          />
          <SidebarRow
            active={filter.kind === "setup"}
            onClick={() => setFilter({ kind: "setup" })}
            icon={<Settings className="size-4" aria-hidden />}
            label="WhatsApp setup"
            ariaLabel="Open WhatsApp setup"
          />
        </div>
      </nav>

    </aside>
  );
}

/** Opens the sidebar drawer on screens too narrow to keep it in view. */
function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open inbox filters"
      className="-ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-sunken hover:text-foreground lg:hidden"
    >
      <Menu className="size-4" aria-hidden />
    </button>
  );
}

function ConversationRow({
  conversation,
  active,
  onClick,
}: {
  conversation: Conversation;
  active: boolean;
  onClick: () => void;
}) {
  const name = contactLabel(conversation.contact);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open conversation with ${name}`}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors duration-150 ${
        active ? "bg-sunken" : "hover:bg-sunken"
      }`}
    >
      <Avatar contact={conversation.contact} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${conversation.unread ? "font-semibold" : "font-medium"}`}
          >
            {name}
          </span>
          {conversation.undelivered ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/30 bg-danger-tint px-1.5 py-px text-[0.6875rem] text-danger">
              <TriangleAlert className="size-3" aria-hidden />
              Not delivered
            </span>
          ) : conversation.stale ? (
            <span
              className="inline-flex shrink-0 items-center rounded-full border border-border bg-sunken px-1.5 py-px text-[0.6875rem] text-muted"
              title="No activity for over a day"
            >
              Stale
            </span>
          ) : null}
          <span className="shrink-0 text-[0.6875rem] text-faint tabular-nums">
            {timeAgo(conversation.lastMessageAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[0.8125rem] leading-[1.45] ${
              conversation.unread ? "text-foreground" : "text-muted"
            }`}
          >
            {conversation.lastMessagePreview || "No messages yet"}
          </span>
          {conversation.unread ? (
            <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
          ) : null}
        </div>
      </div>
    </button>
  );
}

/** `/c/<id>` → the conversation id, or null anywhere else. */
function conversationIdFromPath(): string | null {
  const m = window.location.pathname.match(/^\/c\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Point the address bar at a thread (or back at the inbox).
 *
 * `push` for a navigation the reader made — it should be undoable with the back
 * button. `replace` for corrections they did not ask for, so we never bury the
 * page they arrived from under history they did not create.
 */
function syncUrl(id: string | null, mode: "push" | "replace" = "push") {
  const next = (id ? `/c/${encodeURIComponent(id)}` : "/") + window.location.search;
  if (next === window.location.pathname + window.location.search) return;
  window.history[mode === "push" ? "pushState" : "replaceState"]({ id }, "", next);
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [total, setTotal] = useState(0);
  // The open thread lives in the URL as /c/<id>, so a conversation is a place
  // you can link to, refresh, and reach with the back button — not a mode the
  // app happens to be in. Initialised from the address bar rather than null, so
  // a reload lands on the same thread instead of an empty pane.
  //
  // A path (not ?c=) because the platform deploys apps with
  // not_found_handling: "single-page-application" and run_worker_first limited
  // to /api/* and /llms.txt — so /c/<id> reaches the SPA, verified against the
  // deployer config rather than assumed.
  const [selectedId, setSelectedId] = useState<string | null>(conversationIdFromPath());
  const [showNew, setShowNew] = useState(false);
  /** Sidebar drawer on narrow screens (below lg the sidebar leaves the flow). */
  const [drawer, setDrawer] = useState(false);
  /** A just-opened thread, so it renders before the list has refetched. */
  const [pending, setPending] = useState<Conversation | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  /** Matches inside message bodies, beyond what the preview list shows. */
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    if (!debouncedSearch) {
      setHits(null);
      return;
    }
    let cancelled = false;
    searchMessages(debouncedSearch)
      .then((r) => { if (!cancelled) setHits(r.items); })
      .catch(() => { if (!cancelled) setHits(null); });
    return () => { cancelled = true; };
  }, [debouncedSearch]);

  // A /c/<id> link may point at a thread the current filter, search or page
  // does not contain — a closed one, or simply further down the list. Fetch it
  // directly rather than showing an empty pane for a link that is perfectly
  // valid. If it really is gone, drop back to the inbox and correct the URL
  // (replace, not push: the reader did not ask to go anywhere).
  useEffect(() => {
    if (!selectedId) return;
    if (conversations?.some((c) => c.id === selectedId)) return;
    if (pending?.id === selectedId) return;
    let cancelled = false;
    getConversation(selectedId)
      .then((c) => { if (!cancelled) setPending(c); })
      .catch(() => {
        if (cancelled) return;
        setSelectedId(null);
        syncUrl(null, "replace");
      });
    return () => { cancelled = true; };
  }, [selectedId, conversations, pending]);

  // Back/forward. The browser changed the URL without telling React, so the
  // selection follows the address bar rather than the other way round.
  useEffect(() => {
    const onPop = () => setSelectedId(conversationIdFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Agent mode: larger tap targets + no hover-only affordances (index.css).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("agent") || params.get("mode") === "agent") {
      document.documentElement.setAttribute("data-agent", "");
    }
  }, []);

  useEffect(() => {
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(searchDebounce.current);
  }, [search]);

  const load = useCallback(async () => {
    // Setup is not a conversation view — don't poll the inbox behind it.
    if (filter.kind === "setup") return;
    const params = {
      status: filter.kind === "closed" ? "closed" : "open",
      channel: filter.kind === "channel" ? filter.channel : undefined,
      assignee:
        filter.kind === "mine"
          ? ("me" as const)
          : filter.kind === "unassigned"
            ? ("unassigned" as const)
            : undefined,
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
    };
    const [page, s] = await Promise.all([listConversations(params), getStats()]);
    setConversations(page.items);
    setTotal(page.total);
    setStats(s);
  }, [filter, debouncedSearch]);

  useEffect(() => {
    setConversations(null);
    load().catch(() => {});
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const selected = useMemo(
    () =>
      conversations?.find((c) => c.id === selectedId) ??
      (pending?.id === selectedId ? pending : null),
    [conversations, selectedId, pending],
  );

  /**
   * Show the thread the user just opened. Resets the filter to the whole inbox
   * so a brand-new thread can't land outside the current channel/search view.
   */
  function openStarted(conversation: Conversation) {
    setShowNew(false);
    setPending(conversation);
    setSelectedId(conversation.id);
    syncUrl(conversation.id);
    setSearch("");
    setFilter({ kind: "all" });
  }

  /**
   * Deep link — `/?to=<handle>` opens that contact's thread on load, so another
   * app can hand a person straight to their conversation instead of making the
   * user search for them. Optional `name`, `channel` (default whatsapp), and
   * `linkedApp`/`linkedRef` to tie the contact to the caller's own record.
   *
   * Runs once: the params are stripped afterwards so a refresh doesn't reopen a
   * thread the user has since navigated away from, and so a URL they copy is
   * just the inbox. Everything else in the query (`token`, `agent`) survives.
   */
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;

    const q = new URLSearchParams(window.location.search);
    const handle = q.get("to")?.trim();
    if (!handle) return;

    const linkedApp = q.get("linkedApp");
    const linkedRef = q.get("linkedRef");
    startConversation({
      channel: q.get("channel")?.trim() || "whatsapp",
      handle,
      name: q.get("name")?.trim() || undefined,
      linked: linkedApp && linkedRef ? { appId: linkedApp, ref: linkedRef } : undefined,
    })
      .then(openStarted)
      // A bad handle shouldn't strand the user on a blank screen. They still
      // get the normal inbox and can start the thread by hand.
      .catch(() => {});

    for (const k of ["to", "name", "channel", "linkedApp", "linkedRef"]) q.delete(k);
    const rest = q.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    // openStarted() has already pushed /c/<id>; this only drops the query.
    // Mount-only by design — see the ref guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(conversation: Conversation) {
    setSelectedId(conversation.id);
    syncUrl(conversation.id);
    if (conversation.unread) {
      await patchConversation(conversation.id, { unread: 0 }).catch(() => {});
      load().catch(() => {});
    }
  }

  /** Filter changes made from the drawer also dismiss it. */
  function navigate(f: Filter) {
    setFilter(f);
    setDrawer(false);
  }

  const sidebarDrawer = drawer ? (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div
        className="absolute inset-0 bg-foreground/25"
        onMouseDown={() => setDrawer(false)}
        aria-hidden
      />
      <div className="absolute inset-y-0 left-0 flex shadow-[0_8px_24px_rgba(0,0,0,0.16)]">
        <Sidebar stats={stats} filter={filter} setFilter={navigate} />
      </div>
    </div>
  ) : null;

  if (filter.kind === "setup") {
    return (
      <div className="flex h-full bg-background font-sans text-foreground">
        <div className="hidden shrink-0 lg:flex">
          <Sidebar stats={stats} filter={filter} setFilter={setFilter} />
        </div>
        <WhatsAppSetup menu={<MenuButton onClick={() => setDrawer(true)} />} />
        {sidebarDrawer}
      </div>
    );
  }

  const listTitle =
    filter.kind === "all"
      ? "All open"
      : filter.kind === "mine"
        ? "Mine"
        : filter.kind === "unassigned"
          ? "Unassigned"
          : filter.kind === "closed"
            ? "Closed"
            : channelMeta(filter.channel).label;

  return (
    <div className="flex h-full bg-background font-sans text-foreground">
      <div className="hidden shrink-0 lg:flex">
        <Sidebar stats={stats} filter={filter} setFilter={setFilter} />
      </div>

      {/* Conversation list — on phones it swaps out for the open thread. */}
      <section
        className={`${selected ? "hidden md:flex" : "flex"} w-full min-w-0 shrink-0 flex-col border-r border-border bg-surface md:w-[22rem]`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <MenuButton onClick={() => setDrawer(true)} />
            <Eyebrow>
              {listTitle} · {total}
            </Eyebrow>
          </div>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            aria-label="Start a new conversation"
            className="inline-flex h-8 shrink-0 items-center gap-x-1.5 rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken"
          >
            <PenLine className="size-4" aria-hidden />
            New
          </button>
        </div>
        <div className="shrink-0 border-b border-border p-3">
          <div className="flex h-9 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 focus-within:border-ring">
            <Search className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              className="w-full bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-faint"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations === null ? (
            <p className="pt-12 text-center text-sm text-muted">Loading…</p>
          ) : conversations.length === 0 ? (
            <div className="px-6 pt-12 text-center">
              <p className="text-sm text-muted">
                {debouncedSearch
                  ? "Nothing matches that search."
                  : filter.kind === "closed"
                    ? "No closed conversations yet."
                    : "No conversations yet. Ask your agent to mirror its channels into this inbox — see agent.md."}
              </p>
            </div>
          ) : (
            conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === selectedId}
                onClick={() => select(c)}
              />
            ))
          )}
          {hits && hits.length > 0 ? (
            <div className="border-t border-border">
              <div className="px-4 pb-1 pt-3">
                <Eyebrow>Found in messages</Eyebrow>
              </div>
              {hits.map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  onClick={() => {
                    setSelectedId(hit.conversationId);
                    syncUrl(hit.conversationId);
                    setSearch("");
                    setFilter({ kind: "all" });
                  }}
                  aria-label={`Open the conversation with ${contactLabel(hit.contact)} at the matching message`}
                  className="block w-full border-b border-border px-4 py-2.5 text-left transition-colors duration-150 hover:bg-sunken"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.8125rem] font-medium">
                      {contactLabel(hit.contact)}
                    </span>
                    <span className="shrink-0 text-[0.6875rem] text-faint tabular-nums">
                      {timeAgo(hit.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-[1.45] text-muted">
                    {hit.body}
                  </p>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* Thread */}
      {selected ? (
        <ThreadPane
          // Keyed by thread so switching conversations REMOUNTS rather than
          // reusing the instance. Without it every piece of state outlives the
          // switch: the previous thread's messages paint for a frame before the
          // reset effect runs (effects fire after paint, so resetting there is
          // always one frame late), and worse, a half-typed reply survives into
          // the next thread — you can send one person's message to another.
          key={selected.id}
          conversation={selected}
          onConversationChanged={() => load().catch(() => {})}
          onBack={() => {
            setSelectedId(null);
            syncUrl(null);
          }}
        />
      ) : (
        <section className="hidden min-w-0 flex-1 items-center justify-center bg-background md:flex">
          <div className="text-center">
            <Inbox className="mx-auto size-6 text-faint" aria-hidden />
            <p className="mt-3 text-sm text-muted">Select a conversation to read the thread.</p>
            <button
              type="button"
              onClick={() => setShowNew(true)}
              aria-label="Start a new conversation"
              className="mt-4 inline-flex h-8 items-center gap-x-1.5 rounded-sm bg-primary px-2 text-sm font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover"
            >
              <PenLine className="size-4" aria-hidden />
              New conversation
            </button>
          </div>
        </section>
      )}

      {showNew ? (
        <NewConversationDialog onClose={() => setShowNew(false)} onOpened={openStarted} />
      ) : null}

      {sidebarDrawer}
    </div>
  );
}
