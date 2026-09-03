import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";
import type { Phone } from "./api";
import { listPhones, registerPhone, setDefaultPhone } from "./api";
import { TemplatesPanel } from "./templates";
import { Eyebrow } from "./ui";

/**
 * WhatsApp numbers and whether they can actually send.
 *
 * A number is only usable once Meta has *registered* it with the Cloud API —
 * ownership being verified isn't enough. Until then every queued message fails
 * at the provider no matter how healthy the inbox looks, which is invisible
 * from the conversation list. This panel is where that becomes visible.
 */
export function WhatsAppSetup({ menu }: { menu?: React.ReactNode }) {
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [wabaId, setWabaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { items, wabaId } = await listPhones();
      setPhones(items);
      setWabaId(wabaId);
    } catch (err) {
      setPhones([]);
      setError(err instanceof Error ? err.message : "Could not read the WhatsApp account.");
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-5">
        {menu}
        <h1 className="flex-1 text-[1.25rem] font-bold leading-tight tracking-[-0.01em]">
          WhatsApp setup
        </h1>
        <button
          type="button"
          onClick={() => load()}
          aria-label="Reload phone numbers"
          className="inline-flex h-8 items-center gap-x-1.5 rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken"
        >
          <RefreshCw className="size-4" aria-hidden />
          Reload
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl">
          <Eyebrow>Sending numbers · {phones?.length ?? 0}</Eyebrow>
          {wabaId ? <p className="mt-1 text-xs text-muted">WABA ID · {wabaId}</p> : null}

          {error ? (
            <p role="alert" className="mt-3 text-[0.8125rem] leading-[1.45] text-danger">
              {error}
            </p>
          ) : null}

          {phones === null ? (
            <p className="pt-10 text-center text-sm text-muted">Loading numbers…</p>
          ) : phones.length === 0 ? (
            <p className="pt-10 text-center text-sm leading-relaxed text-muted">
              No numbers on the connected WhatsApp Business account yet. Add one in WhatsApp
              Manager, then reload.
            </p>
          ) : (
            <>
              <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                {phones.map((p) => (
                  <PhoneRow
                    key={p.id}
                    phone={p}
                    busy={registering === p.id}
                    onRegister={() => setRegistering(p.id)}
                    onMakeDefault={async () => {
                      try {
                        await setDefaultPhone(p.id);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not set the default.");
                      }
                    }}
                  />
                ))}
              </div>
              {phones.filter((p) => p.registered).length > 1 &&
              !phones.some((p) => p.isDefault) ? (
                <p className="mt-3 flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-warning">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    More than one number can send and no default is set — outbound messages will
                    fail until you choose one.
                  </span>
                </p>
              ) : null}
            </>
          )}

          <p className="mt-4 text-[0.6875rem] leading-relaxed text-faint">
            Registering sets your account's two-step-verification PIN with Meta. It is sent
            straight to Meta and never stored here — keep your own record of it, because Meta asks
            for it again on any re-registration or number migration.
          </p>

          {/* Templates are WhatsApp's, not the inbox's — same page as the
              numbers that send them. */}
          <div className="mt-10 border-t border-border pt-6">
            <TemplatesPanel />
          </div>
        </div>
      </div>

      {registering ? (
        <RegisterDialog
          phone={phones!.find((p) => p.id === registering)!}
          onClose={() => setRegistering(null)}
          onDone={async () => {
            setRegistering(null);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

function PhoneRow({
  phone,
  busy,
  onRegister,
  onMakeDefault,
}: {
  phone: Phone;
  busy: boolean;
  onRegister: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{phone.displayPhoneNumber}</span>
          {phone.isDefault ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-sunken px-2 py-0.5 text-[0.6875rem] text-muted">
              Default
            </span>
          ) : null}
          {phone.registered ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success-tint px-2 py-0.5 text-xs font-normal text-success">
              <CheckCircle2 className="size-3" aria-hidden />
              Can send
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning-tint px-2 py-0.5 text-xs font-normal text-warning">
              <TriangleAlert className="size-3" aria-hidden />
              Not registered
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[0.8125rem] leading-[1.45] text-muted">
          {phone.verifiedName} · ownership {phone.codeVerificationStatus.toLowerCase()} ·{" "}
          <span className="font-mono text-[0.75rem]">{phone.id}</span>
        </p>
      </div>
      {phone.registered ? (
        phone.isDefault ? null : (
          <button
            type="button"
            onClick={onMakeDefault}
            aria-label={`Send from ${phone.displayPhoneNumber} by default`}
            className="inline-flex h-8 shrink-0 items-center rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken"
          >
            Make default
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={onRegister}
          disabled={busy}
          aria-label={`Register ${phone.displayPhoneNumber} with the Cloud API`}
          className="inline-flex h-8 shrink-0 items-center rounded-sm bg-primary px-2 text-sm font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50"
        >
          Register
        </button>
      )}
    </div>
  );
}

function RegisterDialog({
  phone,
  onClose,
  onDone,
}: {
  phone: Phone;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await registerPhone(phone.id, pin);
      setPin("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Meta rejected the registration.");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/25 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Register phone number"
        className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold leading-tight">Register {phone.displayPhoneNumber}</h2>
          <p className="mt-1 text-[0.8125rem] leading-[1.45] text-muted">
            Choose a 6-digit two-step-verification PIN. It goes straight to Meta — we never store
            it, so write it down before you continue.
          </p>
        </div>

        <div className="space-y-1 px-5 py-4">
          <label htmlFor="reg-pin" className="block text-xs font-semibold tracking-[0.04em] text-muted">
            Two-step verification PIN
          </label>
          <input
            id="reg-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="······"
            autoFocus
            className="h-9 w-full rounded-sm border border-border bg-surface px-2.5 font-mono text-[0.8125rem] tracking-[0.3em] text-foreground outline-none transition-colors duration-150 focus:border-ring placeholder:text-faint placeholder:tracking-normal"
          />
          {error ? (
            <p role="alert" className="pt-1 text-[0.8125rem] leading-[1.45] text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !/^\d{6}$/.test(pin)}
            aria-label="Register this number with Meta"
            className="inline-flex h-8 items-center rounded-sm bg-primary px-2 text-sm font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? "Registering…" : "Register"}
          </button>
        </div>
      </form>
    </div>
  );
}
