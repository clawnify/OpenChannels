/** Typed client for the open-channels API — plain fetch against /api/*. */

export interface Contact {
  id: string;
  channel: string;
  handle: string;
  /** Curated label, set by a human. Null unless someone chose one. */
  name: string | null;
  /** The contact's own channel profile name, refreshed from inbound. */
  profileName: string | null;
  avatarUrl: string | null;
  /**
   * The person this channel identity belongs to in the org's people app. The
   * link only — fetch the record itself with getContactProfile when you show
   * it, so the inbox never renders a stale copy of someone else's data.
   */
  linked: { appId: string; ref: string } | null;
}

/** One person as the org's system of record describes them. */
export interface Profile {
  ref: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  profileUrl: string | null;
}

/**
 * What to call a contact: the curated name if someone set one, else the
 * channel's profile name, else the raw handle. One helper so every surface
 * agrees — a name a human typed must never be shadowed by provider data.
 */
export const contactLabel = (c: Contact): string =>
  c.name?.trim() || c.profileName?.trim() || c.handle;

/**
 * What a thread accepts right now. On WhatsApp, freeform is only allowed for
 * 24 hours after the contact's last message; outside that (and for a contact
 * who has never written) the only way through is an approved template.
 */
export interface SendWindow {
  freeformAllowed: boolean;
  expiresAt: string | null;
  lastInboundAt: string | null;
}

export interface Conversation {
  id: string;
  channel: string;
  subject: string | null;
  status: string;
  unread: number;
  /** The last real message is an outbound the channel did not deliver. */
  undelivered: boolean;
  lastMessageAt: string;
  lastMessagePreview: string;
  contact: Contact;
  window: SendWindow;
}

export interface Message {
  id: string;
  conversationId: string;
  kind: string; // inbound | outbound | system | comment
  body: string;
  authorName: string | null;
  status: string | null; // queued | sent | failed (outbound only)
  error: string | null;
  createdAt: string;
  templateName: string | null;
  mediaRef: string | null;
  mediaType: string | null;
  /** Set once the attachment's bytes live in the app's own storage. */
  mediaKey: string | null;
  mediaMime: string | null;
  mediaName: string | null;
}

/** How a message's attachment should show in the timeline. */
export const messageMediaSrc = (key: string): string => `/api/media/${key}`;

/** True when the stored bytes are renderable inline (an <img> can show them). */
export const isImageMime = (mime: string | null): boolean => !!mime?.startsWith("image/");

export interface Template {
  id: string;
  channel: string;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  /** Placeholder tokens in bodyText, in order: ["1","2"] or ["first_name"]. */
  variables: string[];
  /** The provider's own component array — carries the example values an edit
   *  has to send back, and the header/footer/buttons an edit leaves alone. */
  components: unknown[];
  syncedAt: string;
}

export interface Stats {
  totalOpen: number;
  totalUnread: number;
  queued: number;
  channels: { channel: string; open: number }[];
}

/** Carries the server's own message so the composer can show it verbatim. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    // A 409 (window shut) or 422 (bad template) carries a sentence worth
    // showing the user — don't flatten it to a status code.
    let message = `${init?.method ?? "GET"} ${path} → ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export function listConversations(params: {
  channel?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Conversation[]; total: number }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return request(`/api/conversations?${q}`);
}

export const getStats = (): Promise<Stats> => request("/api/stats");

export const getMessages = (
  conversationId: string,
  limit = 100,
): Promise<{ items: Message[]; hasMore: boolean }> =>
  request(`/api/conversations/${conversationId}/messages?limit=${limit}`);

/** Freeform text — rejected with 409 when the send window is shut. */
export const sendReply = (
  conversationId: string,
  body: string,
  fromPhoneNumberId?: string,
  attachment?: { url: string },
): Promise<Message> =>
  request(`/api/conversations/${conversationId}/reply`, {
    method: "POST",
    body: JSON.stringify({
      // An attachment-only reply has no text; sending an empty body would
      // fail validation, so it is omitted rather than zero-length.
      ...(body ? { body } : {}),
      fromPhoneNumberId,
      ...(attachment ? { attachment } : {}),
    }),
  });

/**
 * Upload a file to attach to a reply. Raw binary body, filename in the query
 * string; returns the public URL to pass back as `attachment.url`.
 */
export const uploadAttachment = async (
  file: File,
): Promise<{ key: string; url: string; mime: string | null }> => {
  const res = await fetch(`/api/uploads?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let message = `POST /api/uploads → ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the status line */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<{ key: string; url: string; mime: string | null }>;
};

/** An approved template — always accepted, and the only way to re-open a thread. */
export const sendTemplate = (
  conversationId: string,
  template: { name: string; language: string; variables: Record<string, string> },
  fromPhoneNumberId?: string,
): Promise<Message> =>
  request(`/api/conversations/${conversationId}/reply`, {
    method: "POST",
    body: JSON.stringify({ template, fromPhoneNumberId }),
  });

export const startConversation = (input: {
  channel: string;
  handle: string;
  name?: string;
  subject?: string;
  linked?: { appId: string; ref: string };
}): Promise<Conversation> =>
  request("/api/conversations", { method: "POST", body: JSON.stringify(input) });

export interface ProfileSource {
  appId: string;
  label?: string;
  fields: { ref: string; name?: string; phone?: string; email?: string };
}

/** Null when the org hasn't pointed the inbox at a people app. */
export const getProfileSource = (): Promise<{ source: ProfileSource | null }> =>
  request("/api/profile-source");

/** Type-ahead over the org's people app. Empty when none is configured. */
export const searchProfiles = (q: string, limit = 8): Promise<{ items: Profile[] }> =>
  request(`/api/profile-source/search?q=${encodeURIComponent(q)}&limit=${limit}`);

/** Resolve one contact's linked person, live from the people app. */
export const getContactProfile = (contactId: string): Promise<Profile> =>
  request(`/api/contacts/${contactId}/profile`);

export interface Phone {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  codeVerificationStatus: string;
  platformType: string;
  qualityRating: string;
  /** Ready to send — anything else and every queued message fails at Meta. */
  registered: boolean;
  /** Outbound WhatsApp leaves from this number unless overridden per send. */
  isDefault: boolean;
}

export const setDefaultPhone = (id: string): Promise<{ ok: boolean }> =>
  request(`/api/whatsapp/phones/${id}/default`, { method: "POST" });

export const listPhones = (): Promise<{ wabaId: string; items: Phone[] }> =>
  request("/api/whatsapp/phones");

/** PIN goes straight to Meta; it is never stored here or returned. */
export const registerPhone = (id: string, pin: string): Promise<{ ok: boolean }> =>
  request(`/api/whatsapp/phones/${id}/register`, {
    method: "POST",
    body: JSON.stringify({ pin }),
  });

/** Pull the catalogue from the provider now. The app does this itself. */
export const refreshTemplates = (channel: string): Promise<{ channel: string; count: number }> =>
  request("/api/templates/refresh", { method: "POST", body: JSON.stringify({ channel }) });

/**
 * Submit new body text for a template. This writes to the PROVIDER — the
 * template goes back into review and leaves the send picker until approved.
 * `variables_changed` reports the edit that breaks existing automations.
 */
export const editTemplate = (
  id: string,
  bodyText: string,
  /** One per {{n}}. Omit to keep the samples already on the template. */
  samples?: string[],
): Promise<{
  template: Template;
  variables_changed: boolean;
  variables_before: string[];
  variables_after: string[];
}> =>
  request(`/api/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(samples ? { bodyText, samples } : { bodyText }),
  });

/**
 * Create a template at the provider. It arrives here PENDING and is not
 * sendable until the provider approves it. Every {{n}} needs a sample value —
 * the provider cannot categorise a template with variables and no examples.
 */
export const createTemplate = (input: {
  channel?: string;
  name: string;
  language: string;
  category: string;
  bodyText: string;
  samples: string[];
}): Promise<Template> =>
  request("/api/templates", { method: "POST", body: JSON.stringify(input) });

/**
 * Delete a template at the provider. Not reversible, and the provider blocks
 * re-use of the name for 30 days — an edit is the way to fix copy.
 */
export const deleteTemplate = (
  id: string,
): Promise<{ deleted: string; name: string; language: string }> =>
  request(`/api/templates/${id}`, { method: "DELETE" });

export function listTemplates(params: {
  channel?: string;
  search?: string;
  limit?: number;
  /** "all" to include templates in review — the composer wants APPROVED only
   *  (the server default), the management screen wants everything. */
  status?: string;
}): Promise<{ items: Template[]; total: number }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return request(`/api/templates?${q}`);
}

export const addComment = (conversationId: string, body: string): Promise<Message> =>
  request(`/api/conversations/${conversationId}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });

/** One thread by id — used to resolve a /c/<id> link to a thread the current
 *  filter or page does not include. */
export const getConversation = (conversationId: string): Promise<Conversation> =>
  request(`/api/conversations/${conversationId}`);

export const patchConversation = (
  conversationId: string,
  patch: { status?: "open" | "closed"; unread?: 0 },
): Promise<{ ok: boolean }> =>
  request(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
