import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppNav, reportLocation, type AppNavGroup, type NavColor } from "@clawnify/app/client";
import { Inbox, PenLine, Search, TriangleAlert } from "lucide-react";
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
import { Avatar, SectionLabel, CHANNELS, channelClass, channelMeta, timeAgo } from "./ui";

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

/**
 * How a channel draws in the navigation.
 *
 * `icon` is a name from the platform's TILE_ICONS library — anything outside it
 * renders as a plain dot in the Clawnify sidebar — and `color` matches the hue
 * the same channel carries everywhere else in the app (--ch-* in index.css), so
 * the nav tile and the thread's brand mark read as one system.
 */
const CHANNEL_NAV: Record<string, { icon: string; color?: NavColor }> = {
  whatsapp: { icon: "message-square", color: "green" },
  telegram: { icon: "send", color: "blue" },
  slack: { icon: "hash", color: "violet" },
  email: { icon: "mail", color: "orange" },
  sms: { icon: "phone", color: "sky" },
  linkedin: { icon: "briefcase", color: "blue" },
  other: { icon: "message-square" },
};

const channelNav = (channel: string) => CHANNEL_NAV[channel] ?? CHANNEL_NAV.other;

/** The `id` <AppNav> hands back on click, and the value `active` is matched on. */
const navId = (filter: Filter) =>
  filter.kind === "channel" ? `ch:${filter.channel}` : filter.kind;

/** Every view is a real URL, so back, reload and cmd-click all behave. */
function filterPath(filter: Filter): string {
  switch (filter.kind) {
    case "channel":
      return `/ch/${encodeURIComponent(filter.channel)}`;
    case "mine":
      return "/mine";
    case "unassigned":
      return "/unassigned";
    case "closed":
      return "/closed";
    case "setup":
      return "/setup";
    default:
      return "/";
  }
}

function filterFromId(id: string): Filter {
  if (id.startsWith("ch:")) return { kind: "channel", channel: id.slice(3) };
  if (id === "mine") return { kind: "mine" };
  if (id === "unassigned") return { kind: "unassigned" };
  if (id === "closed") return { kind: "closed" };
  if (id === "setup") return { kind: "setup" };
  return { kind: "all" };
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
      className={`flex w-full items-stretch gap-2.5 border-b border-border py-3 pl-2 pr-4 text-left transition-colors duration-150 ${
        active ? "bg-sunken" : "hover:bg-sunken"
      }`}
    >
      {/* Category as a 3px inset bar: the cheapest visible classification there
          is, and it never competes with the text beside it. */}
      <span
        className={`channel-dot ${channelClass(conversation.channel)} my-0.5 w-[3px] shrink-0 rounded-full`}
        aria-hidden
      />
      <Avatar contact={conversation.contact} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${conversation.unread ? "font-semibold" : "font-medium"}`}
          >
            {name}
          </span>
          {conversation.undelivered ? (
            <span className="badge badge-danger">
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
          <span className="data shrink-0 text-xs text-faint">
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
            <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />
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
 * The view a path names. A thread path (`/c/<id>`) carries no filter of its
 * own: opening a thread never changes which list you came from, and a cold load
 * of a thread link lands on the whole inbox behind it.
 */
function filterFromPath(): Filter {
  const path = window.location.pathname;
  if (path === "/mine") return { kind: "mine" };
  if (path === "/unassigned") return { kind: "unassigned" };
  const channel = path.match(/^\/ch\/([^/?#]+)/);
  if (channel) return { kind: "channel", channel: decodeURIComponent(channel[1]) };
  if (path === "/closed") return { kind: "closed" };
  if (path === "/setup") return { kind: "setup" };
  return { kind: "all" };
}

/**
 * Point the address bar at a view, and tell the dashboard host where we are so
 * a reload inside it restores the same screen.
 *
 * `push` for a navigation the reader made — it should be undoable with the back
 * button. `replace` for corrections they did not ask for, so we never bury the
 * page they arrived from under history they did not create.
 */
function syncUrl(path: string, mode: "push" | "replace" = "push") {
  const next = path + window.location.search;
  if (next !== window.location.pathname + window.location.search) {
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", next);
  }
  reportLocation(next);
}

const threadPath = (id: string) => `/c/${encodeURIComponent(id)}`;

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>(filterFromPath);
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
        syncUrl("/", "replace");
      });
    return () => { cancelled = true; };
  }, [selectedId, conversations, pending]);

  // Back/forward. The browser changed the URL without telling React, so the
  // selection follows the address bar rather than the other way round.
  useEffect(() => {
    const onPop = () => {
      setSelectedId(conversationIdFromPath());
      setFilter(filterFromPath());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Tell the host where we started, so a dashboard reload restores this screen
  // rather than dropping the reader back on the inbox.
  useEffect(() => {
    reportLocation(window.location.pathname + window.location.search);
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
    syncUrl(threadPath(conversation.id));
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
    syncUrl(threadPath(conversation.id));
    if (conversation.unread) {
      await patchConversation(conversation.id, { unread: 0 }).catch(() => {});
      load().catch(() => {});
    }
  }

  /** A nav row: the view becomes the URL, and any open thread closes with it. */
  function navigate(next: Filter) {
    setFilter(next);
    setSelectedId(null);
    syncUrl(filterPath(next));
  }

  // Channels appear once they carry something. The list is the org's real
  // channel mix rather than a menu of everything the app could mirror.
  const channelCount = (ch: string) => stats?.channels.find((c) => c.channel === ch)?.open ?? 0;
  const activeChannels = Object.keys(CHANNELS).filter((ch) => channelCount(ch) > 0);

  /**
   * The app's navigation, declared once.
   *
   * Standalone, <AppNav> paints it as the sidebar; inside the Clawnify
   * dashboard it paints nothing and hands the same list to the host, which
   * lists it under the app's own group — so the user sees one nav, not two.
   * It is plain data, so the live counts are just state.
   */
  const navGroups: AppNavGroup[] = [
    {
      items: [
        // The home item is not drawn as a row: the app's name opens it.
        { id: "all", label: "Inbox", href: "/", icon: "inbox", home: true },
        ...activeChannels.map((ch) => ({
          id: `ch:${ch}`,
          label: channelMeta(ch).label,
          href: filterPath({ kind: "channel", channel: ch }),
          count: channelCount(ch),
          ...channelNav(ch),
        })),
      ],
    },
    {
      label: "Views",
      items: [
        { id: "mine", label: "Mine", href: "/mine", icon: "user", count: stats?.mine },
        { id: "unassigned", label: "Unassigned", href: "/unassigned", icon: "users", count: stats?.unassigned },
        { id: "closed", label: "Closed", href: "/closed", icon: "archive" },
        { id: "setup", label: "WhatsApp setup", href: "/setup", icon: "settings" },
      ],
    },
  ];

  const nav = (
    <AppNav
      title="Channels"
      icon="inbox"
      groups={navGroups}
      active={navId(filter)}
      onNavigate={(item) => navigate(filterFromId(item.id))}
    />
  );

  // <AppNav> is a 260px column at md and up and a horizontal strip below it, so
  // it goes first inside a flex-col → md:flex-row shell.
  const shell = "flex h-full min-h-0 flex-col bg-background font-sans text-foreground md:flex-row";

  if (filter.kind === "setup") {
    return (
      <div className={shell}>
        {nav}
        <WhatsAppSetup />
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
    <div className={shell}>
      {nav}

      {/* Conversation list — on phones it swaps out for the open thread. */}
      <section
        className={`${selected ? "hidden md:flex" : "flex"} w-full min-h-0 min-w-0 shrink-0 flex-col border-r border-border bg-surface md:w-[22rem]`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-[0.9375rem] font-semibold leading-tight">{listTitle}</h1>
            <span className="data shrink-0 text-xs text-muted">{total}</span>
            {stats && stats.queued > 0 ? (
              <span className="badge badge-warning" title="Waiting for your agent to send">
                {stats.queued} queued
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            aria-label="Start a new conversation"
            className="btn btn-secondary"
          >
            <PenLine className="size-4" aria-hidden />
            New
          </button>
        </div>
        <div className="shrink-0 border-b border-border p-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              className="input pl-8 text-sm"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations === null ? (
            <ConversationsSkeleton />
          ) : conversations.length === 0 ? (
            <EmptyList
              search={debouncedSearch}
              filter={filter}
              onClearSearch={() => setSearch("")}
              onNew={() => setShowNew(true)}
            />
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
                <SectionLabel>Found in messages</SectionLabel>
              </div>
              {hits.map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  onClick={() => {
                    setSelectedId(hit.conversationId);
                    syncUrl(threadPath(hit.conversationId));
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
            syncUrl(filterPath(filter));
          }}
        />
      ) : (
        /* Desktop placeholder, not an empty state: the way forward already sits
           in the list beside it, and a second ink button here would give the
           screen two. */
        <section className="hidden min-w-0 flex-1 items-center justify-center bg-background md:flex">
          <div className="text-center">
            <Inbox className="mx-auto size-6 text-faint" aria-hidden />
            <p className="mt-3 text-sm text-muted">Select a conversation to read the thread.</p>
          </div>
        </section>
      )}

      {showNew ? (
        <NewConversationDialog onClose={() => setShowNew(false)} onOpened={openStarted} />
      ) : null}
    </div>
  );
}

/**
 * The shape of the list that is coming, in `sunken` with a slow shimmer.
 *
 * A centred "Loading…" line was honest but re-flowed the whole rail every time
 * the filter changed, which reads as a flicker even when nothing is wrong.
 */
function ConversationsSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations">
      {[68, 54, 72, 46, 60, 50].map((w, i) => (
        <div key={i} aria-hidden className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-sunken" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <div className="h-2.5 w-24 animate-pulse rounded-full bg-sunken" />
            <div className="h-2.5 animate-pulse rounded-full bg-sunken" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Never a bare "No data".
 *
 * A filtered list with no matches is a different thing from an inbox with
 * nothing in it: it says what was filtered and offers to clear it, and it must
 * not offer to create — the thing the reader is looking for may well exist.
 */
function EmptyList({
  search,
  filter,
  onClearSearch,
  onNew,
}: {
  search: string;
  filter: Filter;
  onClearSearch: () => void;
  onNew: () => void;
}) {
  if (search) {
    return (
      <div className="px-6 pt-12 text-center">
        <p className="text-sm leading-relaxed text-muted">
          Nothing in this view matches “{search}”.
        </p>
        <button type="button" onClick={onClearSearch} className="btn btn-ghost mx-auto mt-3">
          Clear search
        </button>
      </div>
    );
  }
  if (filter.kind === "closed") {
    return (
      <div className="px-6 pt-12 text-center">
        <p className="text-sm leading-relaxed text-muted">
          Nothing has been closed yet. Closing a thread files it here without deleting anything.
        </p>
      </div>
    );
  }
  return (
    <div className="px-6 pt-12 text-center">
      <Inbox className="mx-auto size-6 text-faint" aria-hidden />
      <p className="mt-3 text-sm leading-relaxed text-muted">
        No conversations here yet. Your agent adds one the first time it mirrors a message — see
        agent.md — or write to someone first.
      </p>
      <button
        type="button"
        onClick={onNew}
        aria-label="Start a new conversation"
        className="btn btn-primary mx-auto mt-4"
      >
        <PenLine className="size-4" aria-hidden />
        New conversation
      </button>
    </div>
  );
}
