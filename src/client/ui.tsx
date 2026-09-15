import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Hash, Mail, MessageCircle, MessageSquare, Send } from "lucide-react";
import { logoUrl } from "@clawnify/logokit";
import type { Contact } from "./api";

export const CHANNELS: Record<string, { label: string; icon: LucideIcon; brandDomain?: string }> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircle, brandDomain: "whatsapp.com" },
  telegram: { label: "Telegram", icon: Send, brandDomain: "telegram.org" },
  slack: { label: "Slack", icon: Hash, brandDomain: "slack.com" },
  email: { label: "Email", icon: Mail },
  sms: { label: "SMS", icon: MessageSquare },
  other: { label: "Other", icon: MessageSquare },
};

export const channelMeta = (channel: string) => CHANNELS[channel] ?? CHANNELS.other;
/** CSS hook — pairs with .channel-dot / .channel-chip in index.css. */
export const channelClass = (channel: string) => (channel in CHANNELS ? `ch-${channel}` : "ch-other");

/**
 * Real brand mark (SVG via @clawnify/logokit) for channels that have one.
 * shortcut: bundles logokit's full offline brand index (~200KB min) to resolve
 * three static domains; inline the three URLs at build time if bundle size matters.
 */
export const channelLogo = (channel: string): string | null => {
  const domain = channelMeta(channel).brandDomain;
  return domain ? logoUrl(domain, { format: "vector" }) : null;
};

/** Brand logo when the channel has one, lucide line icon otherwise. */
export function ChannelMark({ channel, className }: { channel: string; className: string }) {
  const brand = channelLogo(channel);
  const [failed, setFailed] = useState<string | null>(null);
  if (brand && brand !== failed) return <img src={brand} alt="" className={className} onError={() => setFailed(brand)} />;
  const Icon = channelMeta(channel).icon;
  return <Icon className={className} aria-hidden />;
}

/**
 * The label above a zone: 13px, sentence case, muted.
 *
 * Deliberately not the 11px uppercase tracked style this used to be. That one
 * exists for exactly one job — the label above a KPI number — and an interface
 * covered in small caps reads as a control panel rather than a product
 * (DESIGN.md, Signature 3).
 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="section-label">{children}</div>;
}

export function ChannelChip({ channel }: { channel: string }) {
  const meta = channelMeta(channel);
  return (
    <span
      className={`channel-chip ${channelClass(channel)} inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium`}
    >
      <ChannelMark channel={channel} className="size-3" />
      {meta.label}
    </span>
  );
}

const initials = (contact: Contact) => {
  const source = contact.name ?? contact.profileName ?? contact.handle;
  const parts = source.replace(/^[+@]/, "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export function Avatar({ contact, size = 9 }: { contact: Contact; size?: 8 | 9 }) {
  const dim = size === 8 ? "size-8 text-xs" : "size-9 text-sm";
  return (
    <div className="relative shrink-0">
      {contact.avatarUrl ? (
        <img src={contact.avatarUrl} alt="" className={`${dim} rounded-full object-cover`} />
      ) : (
        <div
          className={`${dim} rounded-full bg-sunken text-muted flex items-center justify-center font-medium`}
        >
          {initials(contact)}
        </div>
      )}
      {channelLogo(contact.channel) ? (
        /* Brand badge over imagery: white keyline circle (DESIGN.md keylines). */
        <span
          className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-surface shadow-edge"
          aria-hidden
        >
          <ChannelMark channel={contact.channel} className="size-2.5" />
        </span>
      ) : (
        <span
          className={`channel-dot ${channelClass(contact.channel)} absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-surface`}
          aria-hidden
        />
      )}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
