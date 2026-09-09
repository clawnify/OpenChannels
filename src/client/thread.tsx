import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Bot,
  CheckCheck,
  ChevronLeft,
  FileText,
  Paperclip,
  RotateCcw,
  StickyNote,
  TriangleAlert,
} from "lucide-react";
import type { Conversation, Message, Phone } from "./api";
import { addComment, contactLabel, getMessages, listPhones, patchConversation, sendReply } from "./api";
import { TemplateComposer } from "./compose";
import { EmojiPicker } from "./emoji";
import { Avatar, ChannelChip, channelMeta, timeOfDay } from "./ui";

const POLL_MS = 4000;

function OutboundStatus({ message }: { message: Message }) {
  if (message.status === "queued") {
    return (
      <span className="badge badge-warning">Queued for the agent</span>
    );
  }
  if (message.status === "accepted") {
    return (
      <span
        className="chip rounded-full"
        title="WhatsApp accepted it for delivery. Delivery is only confirmed once receipts are wired up."
      >
        Accepted
      </span>
    );
  }
  if (message.status === "failed") {
    return (
      <span
        className="badge badge-danger"
        title={message.error ?? undefined}
      >
        <TriangleAlert className="size-3" aria-hidden /> Failed
      </span>
    );
  }
  // Left our side, then the channel refused to deliver it — a wrong number, or
  // throttling. Reads as loudly as a failure because to the person waiting for
  // a reply it IS one: nobody received this. The reason decides what to do
  // next, so it is shown rather than hidden in a tooltip.
  if (message.status === "undelivered") {
    return (
      <span className="badge badge-danger max-w-full">
        <TriangleAlert className="size-3 shrink-0" aria-hidden />
        <span className="truncate">Not delivered{message.error ? ` — ${message.error}` : ""}</span>
      </span>
    );
  }
  if (message.status === "read") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-success"
        title="Read by the recipient"
      >
        <CheckCheck className="size-3.5" aria-hidden /> Read
      </span>
    );
  }
  if (message.status === "delivered") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted"
        title="Delivered to the recipient's phone"
      >
        <CheckCheck className="size-3.5" aria-hidden /> Delivered
      </span>
    );
  }
  return <CheckCheck className="size-3.5 text-faint" aria-label="Sent" />;
}

function MessageRow({ message }: { message: Message }) {
  if (message.kind === "system") {
    return (
      <div className="flex items-center justify-center gap-1.5 px-4 text-[0.6875rem] leading-relaxed text-muted md:px-6">
        <Bot className="size-3 shrink-0" aria-hidden />
        <span>
          {message.body} · {timeOfDay(message.createdAt)}
        </span>
      </div>
    );
  }

  if (message.kind === "comment") {
    return (
      <div className="mx-4 rounded-md bg-warning-tint px-3.5 py-2.5 md:mx-6">
        <div className="mb-1 flex items-center gap-1.5 text-[0.8125rem] font-medium text-warning">
          <StickyNote className="size-3.5" aria-hidden />
          Internal note · {message.authorName ?? "Someone"}
        </div>
        <p className="whitespace-pre-wrap text-[0.8125rem] leading-[1.45] text-foreground">{message.body}</p>
      </div>
    );
  }

  const outbound = message.kind === "outbound";
  return (
    <div className={`flex px-4 md:px-6 ${outbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] md:max-w-[70%] ${outbound ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div
          className={
            outbound
              ? "rounded-md bg-surface px-3.5 py-2.5 shadow-edge"
              : "rounded-md bg-sunken px-3.5 py-2.5"
          }
        >
          {message.body ? (
            <p className="whitespace-pre-wrap text-sm leading-normal text-foreground">{message.body}</p>
          ) : null}
          {/* The file itself is not stored yet — only the channel's reference to
              it. Saying so is the point: a caption sitting on its own with no
              hint that a photo came with it reads as the whole message. */}
          {message.mediaRef ? (
            <p
              className={`inline-flex items-center gap-1.5 text-[0.8125rem] text-muted${message.body ? " mt-1.5" : ""}`}
              title={message.mediaRef}
            >
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              {message.mediaType ? `${message.mediaType} attachment` : "Attachment"} — not downloaded
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          {outbound && message.authorName ? <span>{message.authorName}</span> : null}
          <span>{timeOfDay(message.createdAt)}</span>
          {message.templateName ? (
            <span className="chip">
              <FileText className="size-3" aria-hidden />
              {message.templateName}
            </span>
          ) : null}
          {outbound ? <OutboundStatus message={message} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Placeholder bubbles while the thread loads.
 *
 * Shaped like the conversation it is standing in for — alternating sides,
 * varied widths — so the layout does not jump when the real messages arrive.
 * A centred "Loading…" line was honest but re-flowed the whole pane on every
 * switch, which reads as a flicker even when nothing is wrong.
 *
 * The bars are aria-hidden under one labelled status region: a screen reader
 * should hear "loading conversation", not five meaningless rectangles.
 */
function MessagesSkeleton() {
  // Fixed, not random: a skeleton that reshuffles on every render draws the eye
  // to the noise instead of the content it is standing in for.
  const rows: Array<{ mine: boolean; w: string }> = [
    { mine: false, w: "60%" },
    { mine: true, w: "45%" },
    { mine: false, w: "72%" },
    { mine: true, w: "38%" },
    { mine: false, w: "54%" },
  ];
  return (
    <div className="space-y-4 px-4" role="status" aria-label="Loading conversation">
      {rows.map((r, i) => (
        <div
          key={i}
          aria-hidden
          className={`flex ${r.mine ? "justify-end" : "justify-start"}`}
        >
          <div
            className="h-12 animate-pulse rounded-md bg-sunken"
            style={{ width: r.w }}
          />
        </div>
      ))}
    </div>
  );
}

export function ThreadPane({
  conversation,
  onConversationChanged,
  onBack,
}: {
  conversation: Conversation;
  onConversationChanged: () => void;
  /** Phones show one pane at a time — this returns to the conversation list. */
  onBack?: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Drop an emoji where the caret is, not at the end — people add one mid
   * sentence as often as they finish with one. Selected text is replaced, which
   * is what every other editor does.
   */
  const insertEmoji = (emoji: string) => {
    const el = draftRef.current;
    const from = el ? el.selectionStart : draft.length;
    const to = el ? el.selectionEnd : draft.length;
    setDraft(draft.slice(0, from) + emoji + draft.slice(to));
    // The new value only reaches the DOM on the next render, so the caret can
    // only be placed after it — otherwise it snaps back to the end.
    requestAnimationFrame(() => {
      const node = draftRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(from + emoji.length, from + emoji.length);
    });
  };
  /** Registered numbers we can send from — only relevant on WhatsApp. */
  const [phones, setPhones] = useState<Phone[]>([]);
  const [fromId, setFromId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    const { items } = await getMessages(conversation.id);
    setMessages(items);
  }, [conversation.id]);

  useEffect(() => {
    setMessages(null);
    stickToBottom.current = true;
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Sending numbers, once per thread. Only WhatsApp has a choice to make, and
  // only when more than one number is registered — otherwise the org default
  // (or the single number) applies server-side and the picker is noise.
  useEffect(() => {
    if (conversation.channel !== "whatsapp") {
      setPhones([]);
      return;
    }
    let cancelled = false;
    listPhones()
      .then(({ items }) => {
        if (cancelled) return;
        const registered = items.filter((p) => p.registered);
        setPhones(registered);
        setFromId(registered.find((p) => p.isDefault)?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setPhones([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.channel, conversation.id]);

  // Keep the newest message in view unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      if (mode === "reply") await sendReply(conversation.id, body, fromId ?? undefined);
      else await addComment(conversation.id, body);
      setDraft("");
      stickToBottom.current = true;
      await load();
      onConversationChanged();
    } catch (err) {
      // A 409 here means the window lapsed while the draft was open — the
      // composer re-renders into template mode once the parent refreshes.
      setError(err instanceof Error ? err.message : "Could not queue the reply.");
      onConversationChanged();
    } finally {
      setSending(false);
    }
  }

  async function afterTemplateSent() {
    stickToBottom.current = true;
    await load();
    onConversationChanged();
  }

  async function toggleStatus() {
    await patchConversation(conversation.id, {
      status: conversation.status === "open" ? "closed" : "open",
    });
    onConversationChanged();
  }

  const contact = conversation.contact;
  const closed = conversation.status === "closed";
  const channelLabel = channelMeta(conversation.channel).label;
  /** Notes are always freeform — only an outbound reply is window-gated. */
  const templateOnly = mode === "reply" && !conversation.window.freeformAllowed;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Toolbar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-5">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversation list"
            className="btn btn-ghost -ml-2 -mr-1 size-8 shrink-0 px-0 md:hidden"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
        ) : null}
        <Avatar contact={contact} size={8} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[1.375rem] font-semibold leading-tight tracking-[-0.01em]">
              {contactLabel(contact)}
            </h1>
            <ChannelChip channel={conversation.channel} />
            {conversation.window.freeformAllowed ? null : (
              <span className="badge badge-warning">
                <FileText className="size-3" aria-hidden />
                Template only
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted">
            {contact.handle}
            {conversation.subject ? ` · ${conversation.subject}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleStatus}
          aria-label={closed ? "Reopen conversation" : "Close conversation"}
          className="btn btn-secondary"
        >
          {closed ? <RotateCcw className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
          {closed ? "Reopen" : "Close"}
        </button>
      </header>

      {/* Timeline */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto py-5">
        {messages === null ? (
          <MessagesSkeleton />
        ) : messages.length === 0 ? (
          <p className="pt-16 text-center text-sm text-muted">
            No messages here yet. They'll appear as soon as your agent mirrors this thread.
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>

      {/* Composer */}
      <footer className="shrink-0 border-t border-border p-3 md:p-4">
        <div className="card p-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2">
            <div className="segmented" role="tablist" aria-label="Compose mode">
              {(["reply", "note"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className="segmented-item"
                >
                  {m === "reply" ? "Reply" : "Internal note"}
                </button>
              ))}
            </div>
            {mode === "reply" ? (
              <div className="flex items-center gap-2">
                {templateOnly ? (
                  <span className="text-xs text-muted">Template required — window closed</span>
                ) : null}
                {phones.length > 1 ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    From
                    <select
                      value={fromId ?? ""}
                      onChange={(e) => setFromId(e.target.value || null)}
                      aria-label="Send from which number"
                      className="input h-7 w-auto px-1.5 text-xs"
                    >
                      {phones.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayPhoneNumber}
                          {p.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : templateOnly ? null : (
                  <span className="text-xs text-muted">Sent via {conversation.channel}</span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted">Never delivered to the contact</span>
            )}
          </div>

          {templateOnly ? (
            <div className="px-3 py-3">
              <p className="mb-3 flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-muted">
                <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {conversation.window.lastInboundAt
                    ? `${contactLabel(contact)} last wrote over 24 hours ago, so ${channelLabel} only accepts an approved template now.`
                    : `${contactLabel(contact)} hasn't written yet, so ${channelLabel} only accepts an approved template to open the conversation.`}
                </span>
              </p>
              <TemplateComposer
                conversation={conversation}
                fromPhoneNumberId={fromId}
                onSent={afterTemplateSent}
              />
            </div>
          ) : (
            <>
              <textarea
                ref={draftRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder={
                  mode === "reply"
                    ? `Reply to ${contactLabel(contact)}…`
                    : "Add a note for your team and your agent…"
                }
                aria-label={mode === "reply" ? "Reply" : "Internal note"}
                className="w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-faint"
              />
              {error ? (
                <p role="alert" className="px-3 pb-1 text-[0.8125rem] leading-[1.45] text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-between px-3 pb-2.5">
                <EmojiPicker onPick={insertEmoji} />
                {mode === "reply" ? (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={sending || draft.trim() === ""}
                    aria-label="Queue reply for sending"
                    className="btn btn-primary"
                  >
                    {sending ? "Queueing…" : "Send"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={sending || draft.trim() === ""}
                    aria-label="Add internal note"
                    className="btn btn-secondary"
                  >
                    {sending ? "Saving…" : "Add note"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
