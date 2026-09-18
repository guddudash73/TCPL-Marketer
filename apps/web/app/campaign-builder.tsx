"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Sector {
  id: string;
  name: string;
  isActive: boolean;
}

interface Capability {
  id: string;
  sectorId: string;
  name: string;
  isActive: boolean;
}

interface Deliverable {
  id: string;
  capabilityId: string;
  name: string;
  isActive: boolean;
}

interface TargetProfile {
  id: string;
  capabilityId: string;
  name: string;
  isActive: boolean;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  automationMode: string;
}

interface Configuration {
  sectors: Sector[];
  capabilities: Capability[];
  deliverables: Deliverable[];
  targetProfiles: TargetProfile[];
}

interface Draft {
  name: string;
  sectorId: string;
  capabilityIds: string[];
  deliverableIds: string[];
  targetClientProfileIds: string[];
  countries: string;
  minimumEmployees: string;
  maximumEmployees: string;
  researchDepth: string;
  targetLeadCount: string;
  minimumScore: string;
  dailyEmailLimit: string;
  followUpDelayDays: string;
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const emptyConfiguration: Configuration = {
  sectors: [],
  capabilities: [],
  deliverables: [],
  targetProfiles: [],
};

const initialDraft: Draft = {
  name: "LiDAR USA point cloud processing",
  sectorId: "",
  capabilityIds: [],
  deliverableIds: [],
  targetClientProfileIds: [],
  countries: "USA",
  minimumEmployees: "10",
  maximumEmployees: "500",
  researchDepth: "STANDARD",
  targetLeadCount: "50",
  minimumScore: "70",
  dailyEmailLimit: "20",
  followUpDelayDays: "3",
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : body?.message;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function active<T extends { isActive: boolean }>(records: T[]): T[] {
  return records.filter((record) => record.isActive);
}

function toggle(ids: string[], id: string, selected: boolean): string[] {
  return selected ? [...ids, id] : ids.filter((value) => value !== id);
}

export function CampaignBuilder() {
  const [configuration, setConfiguration] =
    useState<Configuration>(emptyConfiguration);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<Campaign>();

  const loadConfiguration = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [sectors, capabilities, deliverables, targetProfiles] =
        await Promise.all([
          apiFetch<Sector[]>("/sectors"),
          apiFetch<Capability[]>("/capabilities"),
          apiFetch<Deliverable[]>("/deliverables"),
          apiFetch<TargetProfile[]>("/target-client-profiles"),
        ]);
      setConfiguration({ sectors, capabilities, deliverables, targetProfiles });
      const lidar = active(sectors).find((sector) => sector.name === "LiDAR");
      if (lidar) setDraft((current) => ({ ...current, sectorId: lidar.id }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load configuration.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    apiFetch<{ user: { roles: string[] } }>("/auth/me")
      .then(({ user }) => {
        if (user.roles.some((role) => role === "ADMIN" || role === "MANAGER")) {
          setSignedIn(true);
          void loadConfiguration();
        }
      })
      .catch(() => undefined);
  }, [loadConfiguration]);

  const capabilities = useMemo(
    () =>
      active(configuration.capabilities).filter(
        (item) => item.sectorId === draft.sectorId,
      ),
    [configuration.capabilities, draft.sectorId],
  );
  const deliverables = useMemo(
    () =>
      active(configuration.deliverables).filter((item) =>
        draft.capabilityIds.includes(item.capabilityId),
      ),
    [configuration.deliverables, draft.capabilityIds],
  );
  const targetProfiles = useMemo(
    () =>
      active(configuration.targetProfiles).filter((item) =>
        draft.capabilityIds.includes(item.capabilityId),
      ),
    [configuration.targetProfiles, draft.capabilityIds],
  );

  function update(key: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function chooseSector(sectorId: string) {
    setDraft((current) => ({
      ...current,
      sectorId,
      capabilityIds: [],
      deliverableIds: [],
      targetClientProfileIds: [],
    }));
  }

  function chooseCapability(capabilityId: string, selected: boolean) {
    setDraft((current) => {
      const capabilityIds = toggle(
        current.capabilityIds,
        capabilityId,
        selected,
      );
      return {
        ...current,
        capabilityIds,
        deliverableIds: current.deliverableIds.filter((id) =>
          configuration.deliverables.some(
            (deliverable) =>
              deliverable.id === id &&
              capabilityIds.includes(deliverable.capabilityId),
          ),
        ),
        targetClientProfileIds: current.targetClientProfileIds.filter((id) =>
          configuration.targetProfiles.some(
            (profile) =>
              profile.id === id && capabilityIds.includes(profile.capabilityId),
          ),
        ),
      };
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setCreated(undefined);
    try {
      const campaign = await apiFetch<Campaign>("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          sectorId: draft.sectorId,
          capabilityIds: draft.capabilityIds,
          deliverableIds: draft.deliverableIds,
          targetClientProfileIds: draft.targetClientProfileIds,
          countries: [draft.countries],
          minimumEmployees: Number(draft.minimumEmployees),
          maximumEmployees: Number(draft.maximumEmployees),
          researchDepth: draft.researchDepth,
          targetLeadCount: Number(draft.targetLeadCount),
          minimumScore: Number(draft.minimumScore),
          automationMode: "MANUAL_REVIEW",
          dailyEmailLimit: Number(draft.dailyEmailLimit),
          sequence: [
            { stepNumber: 1, delayDays: 0 },
            { stepNumber: 2, delayDays: Number(draft.followUpDelayDays) },
          ],
        }),
      });
      setCreated(campaign);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Campaign could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!signedIn)
    return (
      <LoginForm
        onSuccess={() => {
          setSignedIn(true);
          void loadConfiguration();
        }}
      />
    );

  return (
    <main className="campaign-shell">
      <header className="campaign-header">
        <div>
          <p className="eyebrow">TCPL MARKETER / CAMPAIGNS</p>
          <h1>Build a campaign</h1>
          <p>
            Configure a durable draft. Outreach remains in manual review until
            later workflow tasks are complete.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => void loadConfiguration()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh configuration"}
        </button>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <p className="notice success" role="status">
          Created <strong>{created.name}</strong> as a {created.status}{" "}
          {created.automationMode} campaign.
        </p>
      )}
      <form className="campaign-form" onSubmit={submit}>
        <section className="campaign-card">
          <p className="eyebrow">01 / OFFER</p>
          <label>
            Campaign name
            <input
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              required
            />
          </label>
          <label>
            Sector
            <select
              value={draft.sectorId}
              onChange={(event) => chooseSector(event.target.value)}
              required
            >
              <option value="">Select a sector</option>
              {active(configuration.sectors).map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
          </label>
          <SelectionGroup
            label="Capabilities"
            empty="Select a sector first."
            records={capabilities}
            selectedIds={draft.capabilityIds}
            onChange={chooseCapability}
          />
          <SelectionGroup
            label="Deliverables"
            empty="Select a capability first."
            records={deliverables}
            selectedIds={draft.deliverableIds}
            onChange={(id, selected) =>
              setDraft((current) => ({
                ...current,
                deliverableIds: toggle(current.deliverableIds, id, selected),
              }))
            }
          />
          <SelectionGroup
            label="Target clients"
            empty="Select a capability first."
            records={targetProfiles}
            selectedIds={draft.targetClientProfileIds}
            onChange={(id, selected) =>
              setDraft((current) => ({
                ...current,
                targetClientProfileIds: toggle(
                  current.targetClientProfileIds,
                  id,
                  selected,
                ),
              }))
            }
          />
        </section>
        <section className="campaign-card">
          <p className="eyebrow">02 / QUALIFICATION</p>
          <div className="two-column">
            <label>
              Country
              <input
                value={draft.countries}
                onChange={(event) => update("countries", event.target.value)}
                required
              />
            </label>
            <label>
              Research depth
              <select
                value={draft.researchDepth}
                onChange={(event) =>
                  update("researchDepth", event.target.value)
                }
              >
                <option value="STANDARD">Standard</option>
                <option value="DEEP">Deep</option>
              </select>
            </label>
          </div>
          <div className="two-column">
            <NumberField
              label="Minimum employees"
              value={draft.minimumEmployees}
              onChange={(value) => update("minimumEmployees", value)}
            />
            <NumberField
              label="Maximum employees"
              value={draft.maximumEmployees}
              onChange={(value) => update("maximumEmployees", value)}
            />
          </div>
          <div className="two-column">
            <NumberField
              label="Target lead count"
              value={draft.targetLeadCount}
              onChange={(value) => update("targetLeadCount", value)}
              minimum={1}
            />
            <NumberField
              label="Minimum score"
              value={draft.minimumScore}
              onChange={(value) => update("minimumScore", value)}
              minimum={0}
              maximum={100}
            />
          </div>
        </section>
        <section className="campaign-card">
          <p className="eyebrow">03 / REVIEW & SEQUENCE</p>
          <label>
            Automation mode
            <input value="MANUAL_REVIEW" readOnly aria-readonly="true" />
          </label>
          <p className="field-help">
            This demo task cannot start orchestration or send any email.
          </p>
          <div className="two-column">
            <NumberField
              label="Daily email limit"
              value={draft.dailyEmailLimit}
              onChange={(value) => update("dailyEmailLimit", value)}
              minimum={1}
            />
            <NumberField
              label="Follow-up delay (days)"
              value={draft.followUpDelayDays}
              onChange={(value) => update("followUpDelayDays", value)}
              minimum={0}
            />
          </div>
          <ol className="sequence-preview">
            <li>Initial message — day 0</li>
            <li>Follow-up — day {draft.followUpDelayDays || "0"}</li>
          </ol>
          <button
            className="primary-button campaign-submit"
            disabled={submitting || loading}
          >
            {submitting ? "Creating draft…" : "Create MANUAL_REVIEW campaign"}
          </button>
        </section>
      </form>
    </main>
  );
}

function SelectionGroup({
  label,
  empty,
  records,
  selectedIds,
  onChange,
}: {
  label: string;
  empty: string;
  records: Array<{ id: string; name: string }>;
  selectedIds: string[];
  onChange: (id: string, selected: boolean) => void;
}) {
  return (
    <fieldset className="selection-group">
      <legend>{label}</legend>
      {records.length === 0 ? (
        <p className="field-help">{empty}</p>
      ) : (
        records.map((record) => (
          <label className="choice" key={record.id}>
            <input
              type="checkbox"
              checked={selectedIds.includes(record.id)}
              onChange={(event) => onChange(record.id, event.target.checked)}
            />
            {record.name}
          </label>
        ))
      )}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  onChange,
  minimum = 0,
  maximum,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minimum?: number;
  maximum?: number;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={minimum}
        max={maximum}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <p className="eyebrow">TCPL MARKETER</p>
        <h1>Manager sign in</h1>
        <p>
          Use an account with the MANAGER or ADMIN role to build a campaign.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label>
          Email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button className="primary-button" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
