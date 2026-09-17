import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Play, RefreshCw, TriangleAlert } from "lucide-react";
import type { AgentOption, LinkedInSyncRun, LinkedInSyncState } from "./api";
import { getLinkedInSync, listSyncAgents, removeLinkedInSync, runLinkedInSyncNow, saveLinkedInSync } from "./api";
import { Popover, PopoverContent, PopoverTrigger } from "./components/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/command";
import { SectionLabel } from "./ui";

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

/** A small combobox: Popover + Command, searchable when the list is long. */
function Picker<T extends { value: string; label: string; hint?: string }>({
  id,
  label,
  placeholder,
  options,
  value,
  onChange,
  searchable,
}: {
  id: string;
  label: string;
  placeholder: string;
  options: T[];
  value: string;
  onChange: (value: string) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="section-label block">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            className="input flex w-full items-center justify-between gap-2 text-left text-sm"
          >
            <span className={selected ? "truncate" : "truncate text-faint"}>
              {selected ? selected.label : placeholder}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command>
            {searchable ? <CommandInput placeholder={`Search ${label.toLowerCase()}…`} /> : null}
            <CommandList>
              <CommandEmpty>Nothing found.</CommandEmpty>
              <CommandGroup className="p-1">
                {options.map((o) => (
                  <CommandItem
                    key={o.value}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-[0.8125rem]"
                    value={`${o.label} ${o.value}`}
                    onSelect={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={`size-3.5 shrink-0 ${o.value === value ? "opacity-100" : "opacity-0"}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint ? <span className="text-xs text-muted">{o.hint}</span> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function RunRow({ run }: { run: LinkedInSyncRun }) {
  const badge =
    run.status === "done" ? "badge-success" : run.status === "failed" ? "badge-danger" : "badge-info";
  const label = run.status === "done" ? "Done" : run.status === "failed" ? "Failed" : "Running";
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className={`badge ${badge} mt-0.5 shrink-0`}>{label}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] text-foreground">{when(run.startedAt)}</p>
        {run.status === "failed" ? (
          <p className="text-xs leading-relaxed text-danger">{run.error}</p>
        ) : run.status === "done" ? (
          <p className="text-xs text-muted">
            {`${run.mirrored ?? 0} mirrored · ${run.sent ?? 0} sent · ${run.failed ?? 0} not sent`}
          </p>
        ) : (
          <p className="text-xs text-muted">Your agent is working through LinkedIn.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Where a person turns LinkedIn sync on: which agent runs it, how often, and
 * whether it runs at all. Everything the agent does on each run is described
 * in skills/linkedin-sync/SKILL.md; this page never talks to LinkedIn.
 */
export function LinkedInSyncSetup() {
  const [state, setState] = useState<LinkedInSyncState | null>(null);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [serverId, setServerId] = useState("");
  const [cadence, setCadence] = useState("workday-hourly");
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "run" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Kept until the dispatch succeeds, so a retry after a timeout reuses it.
  const runId = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getLinkedInSync();
      setState(s);
      if (s.sync) {
        setServerId(s.sync.serverId);
        setCadence(s.sync.cadence);
        setActive(s.sync.active);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load LinkedIn sync.");
    }
    try {
      const { agents } = await listSyncAgents();
      setAgents(agents);
      setAgentsError(null);
      setServerId((current) => current || (agents.length === 1 ? agents[0].id : ""));
    } catch (err) {
      setAgents([]);
      setAgentsError(err instanceof Error ? err.message : "Could not list your agents.");
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const saved = state?.sync ?? null;
  // Saving always uses the time zone of the browser doing the save.
  const timezone = browserTimezone();
  const dirty =
    !saved ||
    saved.serverId !== serverId ||
    saved.cadence !== cadence ||
    saved.active !== active ||
    saved.timezone !== timezone;

  async function save() {
    if (!serverId || busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const next = await saveLinkedInSync({ serverId, cadence, timezone, active });
      setState(next);
      setNotice(active ? "LinkedIn sync is on." : "LinkedIn sync is off.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      // The server records what it could; show that rather than our guess.
      getLinkedInSync().then(setState).catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    if (busy) return;
    setBusy("run");
    setError(null);
    setNotice(null);
    runId.current ??= crypto.randomUUID();
    try {
      await runLinkedInSyncNow(runId.current);
      runId.current = null;
      setNotice("Sent to your agent. The run appears below once it starts.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a run.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      await removeLinkedInSync();
      setActive(false);
      await load();
      setNotice("LinkedIn sync is removed from your agent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove LinkedIn sync.");
    } finally {
      setBusy(null);
    }
  }

  const agentOptions = (agents ?? []).map((a) => ({
    value: a.id,
    label: a.name || a.id,
    hint: a.status && a.status !== "ready" ? a.status : undefined,
  }));
  // An agent the org no longer lists still shows, so a saved choice is visible.
  if (serverId && !agentOptions.some((o) => o.value === serverId)) {
    agentOptions.unshift({ value: serverId, label: `Saved agent (${serverId.slice(0, 8)})`, hint: "not listed" });
  }
  const cadenceOptions = (state?.cadences ?? []).map((c) => ({ value: c.key, label: c.label }));

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-5">
        <h1 className="flex-1 truncate text-[1.375rem] font-semibold leading-tight tracking-[-0.01em]">
          LinkedIn sync
        </h1>
        <button type="button" onClick={() => load()} aria-label="Reload LinkedIn sync" className="btn btn-secondary">
          <RefreshCw className="size-4" aria-hidden />
          Reload
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <p className="text-[0.8125rem] leading-[1.55] text-muted">
            Your agent opens LinkedIn in its own signed-in browser on a schedule, copies new messages into
            this inbox, and sends the LinkedIn messages people queued here. Each run uses your agent's
            credits. It only messages 1st-degree connections, never writes messages itself, and stops if
            LinkedIn asks it to sign in or slow down.
          </p>

          {error ? (
            <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-[0.8125rem] leading-[1.45] text-success">
              {notice}
            </p>
          ) : null}
          {saved?.scheduleError ? (
            <p className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{`Your agent's scheduler reported a problem: ${saved.scheduleError}`}</span>
            </p>
          ) : null}

          <div className="card space-y-4 p-4">
            <Picker
              id="sync-agent"
              label="Agent"
              placeholder={agents === null ? "Loading agents…" : "Choose the agent signed in to LinkedIn"}
              options={agentOptions}
              value={serverId}
              onChange={setServerId}
              searchable={agentOptions.length > 6}
            />
            {agentsError ? <p className="text-xs text-danger">{agentsError}</p> : null}

            <Picker
              id="sync-cadence"
              label="How often"
              placeholder="Choose a schedule"
              options={cadenceOptions}
              value={cadence}
              onChange={setCadence}
            />
            <p className="text-xs text-muted">
              {saved && saved.timezone !== timezone
                ? `Times are in ${saved.timezone}. Saving here switches them to ${timezone}.`
                : `Times are in ${timezone}.`}
            </p>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <div>
                <p id="sync-on-label" className="text-[0.8125rem] font-medium text-foreground">
                  Sync LinkedIn
                </p>
                <p className="text-xs text-muted">Off by default. Turning it on starts spending credits.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-labelledby="sync-on-label"
                onClick={() => setActive((v) => !v)}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 ${
                  active ? "bg-primary" : "bg-sunken shadow-edge"
                }`}
              >
                <span
                  className={`inline-block size-4 rounded-full bg-surface shadow-edge transition-transform duration-150 ${
                    active ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {saved ? (
                <button type="button" onClick={remove} disabled={busy !== null} className="btn btn-ghost">
                  {busy === "remove" ? "Removing…" : "Remove from agent"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={save}
                disabled={!serverId || !dirty || busy !== null}
                className="btn btn-primary"
              >
                {busy === "save" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          {saved ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[0.8125rem] text-muted">
                {saved.active
                  ? saved.nextRunAt
                    ? `Next run ${when(saved.nextRunAt)}`
                    : "On. Waiting for the next scheduled time."
                  : "Off. Nothing runs until you turn it on."}
              </p>
              <button
                type="button"
                onClick={runNow}
                disabled={!saved.active || busy !== null}
                className="btn btn-secondary"
              >
                <Play className="size-4" aria-hidden />
                {busy === "run" ? "Starting…" : "Run now"}
              </button>
            </div>
          ) : null}

          <div>
            <SectionLabel>Recent runs</SectionLabel>
            {state === null ? (
              <p className="pt-6 text-center text-sm text-muted">Loading…</p>
            ) : state.runs.length === 0 ? (
              <p className="pt-6 text-center text-sm text-muted">No runs yet.</p>
            ) : (
              <div className="card mt-3 divide-y divide-border overflow-hidden p-0">
                {state.runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
