"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Json =
  | Record<string, unknown>
  | string[]
  | string
  | number
  | boolean
  | null;

interface Sector {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  terminology: string[];
  geographies: string[];
  negativeTerms: string[];
  researchRules: Record<string, unknown> | null;
  isActive: boolean;
}

interface Capability {
  id: string;
  sectorId: string;
  name: string;
  slug: string;
  description: string | null;
  businessProblems: string[];
  businessValue: string | null;
  searchGuidance: Record<string, unknown> | null;
  researchGuidance: Record<string, unknown> | null;
  isActive: boolean;
  sector: Sector;
}

interface Deliverable {
  id: string;
  capabilityId: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  capability: Capability;
}

interface TargetProfile {
  id: string;
  capabilityId: string;
  name: string;
  slug: string;
  companyCharacteristics: Record<string, unknown> | null;
  minimumEmployees: number | null;
  maximumEmployees: number | null;
  geographies: string[];
  positiveTerms: string[];
  negativeTerms: string[];
  typicalBusinessModel: string | null;
  outsourcingCharacteristics: string | null;
  isActive: boolean;
  capability: Capability;
}

interface DecisionMaker {
  id: string;
  capabilityId: string;
  title: string;
  priority: number;
  seniorities: string[];
  positiveTerms: string[];
  negativeTerms: string[];
  isActive: boolean;
  capability: Capability;
}

interface Configuration {
  sectors: Sector[];
  capabilities: Capability[];
  deliverables: Deliverable[];
  targetProfiles: TargetProfile[];
  decisionMakers: DecisionMaker[];
}

type SectionKey = keyof Configuration;
type ConfigurationRecord =
  | Sector
  | Capability
  | Deliverable
  | TargetProfile
  | DecisionMaker;
type Draft = Record<string, string | boolean>;

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const sections: Array<{
  key: SectionKey;
  label: string;
  endpoint: string;
  singular: string;
}> = [
  {
    key: "sectors",
    label: "Sectors",
    endpoint: "/sectors",
    singular: "sector",
  },
  {
    key: "capabilities",
    label: "Capabilities",
    endpoint: "/capabilities",
    singular: "capability",
  },
  {
    key: "deliverables",
    label: "Deliverables",
    endpoint: "/deliverables",
    singular: "deliverable",
  },
  {
    key: "targetProfiles",
    label: "Target clients",
    endpoint: "/target-client-profiles",
    singular: "target-client profile",
  },
  {
    key: "decisionMakers",
    label: "Decision makers",
    endpoint: "/decision-maker-profiles",
    singular: "decision-maker profile",
  },
];

const emptyConfiguration: Configuration = {
  sectors: [],
  capabilities: [],
  deliverables: [],
  targetProfiles: [],
  decisionMakers: [],
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
  return (response.status === 204 ? undefined : response.json()) as T;
}

function listValue(value: Json | undefined): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

function jsonValue(value: Json | undefined): string {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.stringify(value, null, 2)
    : "";
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function initialDraft(
  section: SectionKey,
  record?: ConfigurationRecord,
): Draft {
  const base: Draft = { isActive: record?.isActive ?? true };
  if (!record) {
    return section === "decisionMakers" ? { ...base, priority: "1" } : base;
  }

  if (section === "sectors") {
    const sector = record as Sector;
    return {
      ...base,
      name: sector.name,
      description: stringValue(sector.description),
      terminology: listValue(sector.terminology),
      geographies: listValue(sector.geographies),
      negativeTerms: listValue(sector.negativeTerms),
      researchRules: jsonValue(sector.researchRules),
    };
  }
  if (section === "capabilities") {
    const capability = record as Capability;
    return {
      ...base,
      sectorId: capability.sectorId,
      name: capability.name,
      description: stringValue(capability.description),
      businessProblems: listValue(capability.businessProblems),
      businessValue: stringValue(capability.businessValue),
      searchGuidance: jsonValue(capability.searchGuidance),
      researchGuidance: jsonValue(capability.researchGuidance),
    };
  }
  if (section === "deliverables") {
    const deliverable = record as Deliverable;
    return {
      ...base,
      capabilityId: deliverable.capabilityId,
      name: deliverable.name,
      description: stringValue(deliverable.description),
    };
  }
  if (section === "targetProfiles") {
    const profile = record as TargetProfile;
    return {
      ...base,
      capabilityId: profile.capabilityId,
      name: profile.name,
      companyCharacteristics: jsonValue(profile.companyCharacteristics),
      minimumEmployees: stringValue(profile.minimumEmployees),
      maximumEmployees: stringValue(profile.maximumEmployees),
      geographies: listValue(profile.geographies),
      positiveTerms: listValue(profile.positiveTerms),
      negativeTerms: listValue(profile.negativeTerms),
      typicalBusinessModel: stringValue(profile.typicalBusinessModel),
      outsourcingCharacteristics: stringValue(
        profile.outsourcingCharacteristics,
      ),
    };
  }
  const profile = record as DecisionMaker;
  return {
    ...base,
    capabilityId: profile.capabilityId,
    title: profile.title,
    priority: String(profile.priority),
    seniorities: listValue(profile.seniorities),
    positiveTerms: listValue(profile.positiveTerms),
    negativeTerms: listValue(profile.negativeTerms),
  };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nullableText(value: string): string | null {
  return value.trim() || null;
}

function optionalJson(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("JSON fields must contain an object.");
  }
  return parsed as Record<string, unknown>;
}

function payloadFor(
  section: SectionKey,
  draft: Draft,
): Record<string, unknown> {
  const value = (key: string) => String(draft[key] ?? "");
  const base = { isActive: Boolean(draft.isActive) };
  if (section === "sectors")
    return {
      ...base,
      name: value("name"),
      description: nullableText(value("description")),
      terminology: splitList(value("terminology")),
      geographies: splitList(value("geographies")),
      negativeTerms: splitList(value("negativeTerms")),
      researchRules: optionalJson(value("researchRules")),
    };
  if (section === "capabilities")
    return {
      ...base,
      sectorId: value("sectorId"),
      name: value("name"),
      description: nullableText(value("description")),
      businessProblems: splitList(value("businessProblems")),
      businessValue: nullableText(value("businessValue")),
      searchGuidance: optionalJson(value("searchGuidance")),
      researchGuidance: optionalJson(value("researchGuidance")),
    };
  if (section === "deliverables")
    return {
      ...base,
      capabilityId: value("capabilityId"),
      name: value("name"),
      description: nullableText(value("description")),
    };
  if (section === "targetProfiles")
    return {
      ...base,
      capabilityId: value("capabilityId"),
      name: value("name"),
      companyCharacteristics: optionalJson(value("companyCharacteristics")),
      minimumEmployees: value("minimumEmployees")
        ? Number(value("minimumEmployees"))
        : null,
      maximumEmployees: value("maximumEmployees")
        ? Number(value("maximumEmployees"))
        : null,
      geographies: splitList(value("geographies")),
      positiveTerms: splitList(value("positiveTerms")),
      negativeTerms: splitList(value("negativeTerms")),
      typicalBusinessModel: nullableText(value("typicalBusinessModel")),
      outsourcingCharacteristics: nullableText(
        value("outsourcingCharacteristics"),
      ),
    };
  return {
    ...base,
    capabilityId: value("capabilityId"),
    title: value("title"),
    priority: Number(value("priority")),
    seniorities: splitList(value("seniorities")),
    positiveTerms: splitList(value("positiveTerms")),
    negativeTerms: splitList(value("negativeTerms")),
  };
}

function recordName(record: ConfigurationRecord): string {
  return "title" in record ? record.title : record.name;
}

function recordParent(record: ConfigurationRecord): string | undefined {
  if ("sector" in record) return record.sector.name;
  if ("capability" in record) return record.capability.name;
  return undefined;
}

export function ConfigurationAdmin() {
  const [configuration, setConfiguration] =
    useState<Configuration>(emptyConfiguration);
  const [activeSection, setActiveSection] = useState<SectionKey>("sectors");
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const loadConfiguration = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [
        sectors,
        capabilities,
        deliverables,
        targetProfiles,
        decisionMakers,
      ] = await Promise.all([
        apiFetch<Sector[]>("/sectors"),
        apiFetch<Capability[]>("/capabilities"),
        apiFetch<Deliverable[]>("/deliverables"),
        apiFetch<TargetProfile[]>("/target-client-profiles"),
        apiFetch<DecisionMaker[]>("/decision-maker-profiles"),
      ]);
      setConfiguration({
        sectors,
        capabilities,
        deliverables,
        targetProfiles,
        decisionMakers,
      });
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
      .then((result) => {
        if (result.user.roles.includes("ADMIN")) {
          setSignedIn(true);
          void loadConfiguration();
        }
      })
      .catch(() => undefined);
  }, [loadConfiguration]);

  const active = useMemo(
    () => sections.find((section) => section.key === activeSection)!,
    [activeSection],
  );

  if (!signedIn) {
    return (
      <LoginForm
        onSuccess={() => {
          setSignedIn(true);
          void loadConfiguration();
        }}
      />
    );
  }

  return (
    <main className="configuration-shell">
      <header className="configuration-header">
        <div>
          <p className="eyebrow">TCPL MARKETER / ADMIN</p>
          <h1>Business configuration</h1>
          <p>
            Manage the database-backed setup used to build LiDAR and future
            campaigns.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => void loadConfiguration()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <nav className="tabs" aria-label="Configuration areas">
        {sections.map((section) => (
          <button
            className={section.key === activeSection ? "tab active" : "tab"}
            key={section.key}
            onClick={() => setActiveSection(section.key)}
          >
            {section.label}
            <span>{configuration[section.key].length}</span>
          </button>
        ))}
      </nav>
      <ConfigurationSection
        section={active}
        configuration={configuration}
        records={configuration[active.key]}
        onChange={loadConfiguration}
        onError={setError}
      />
    </main>
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
        <h1>Administrator sign in</h1>
        <p>
          Use an account with the ADMIN role to manage business configuration.
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

function ConfigurationSection({
  section,
  configuration,
  records,
  onChange,
  onError,
}: {
  section: (typeof sections)[number];
  configuration: Configuration;
  records: ConfigurationRecord[];
  onChange: () => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [editing, setEditing] = useState<ConfigurationRecord>();
  const [creating, setCreating] = useState(false);
  async function remove(record: ConfigurationRecord) {
    if (
      !window.confirm(
        `Delete ${recordName(record)}? Related configuration may also be removed.`,
      )
    )
      return;
    try {
      onError(undefined);
      await apiFetch(`${section.endpoint}/${record.id}`, { method: "DELETE" });
      await onChange();
      if (editing?.id === record.id) setEditing(undefined);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Delete failed.");
    }
  }
  return (
    <section className="workspace">
      <div className="records">
        <div className="section-heading">
          <div>
            <h2>{section.label}</h2>
            <p>
              Changes are saved directly to the authorized configuration API.
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() => {
              setCreating(true);
              setEditing(undefined);
            }}
          >
            Add {section.singular}
          </button>
        </div>
        <div className="record-list">
          {records.length === 0 ? (
            <p className="empty-state">No {section.label.toLowerCase()} yet.</p>
          ) : (
            records.map((record) => (
              <article
                className={
                  editing?.id === record.id ? "record selected" : "record"
                }
                key={record.id}
              >
                <div>
                  <h3>{recordName(record)}</h3>
                  {recordParent(record) && <p>{recordParent(record)}</p>}
                  <span
                    className={
                      record.isActive ? "status active" : "status inactive"
                    }
                  >
                    {record.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="record-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setCreating(false);
                      setEditing(record);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => void remove(record)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
      {(creating || editing) && (
        <ConfigurationForm
          section={section}
          configuration={configuration}
          record={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(undefined);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(undefined);
            await onChange();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

function ConfigurationForm({
  section,
  configuration,
  record,
  onCancel,
  onSaved,
  onError,
}: {
  section: (typeof sections)[number];
  configuration: Configuration;
  record?: ConfigurationRecord;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(section.key, record),
  );
  const [saving, setSaving] = useState(false);
  const update = (key: string, value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError(undefined);
    try {
      const path = record
        ? `${section.endpoint}/${record.id}`
        : section.endpoint;
      await apiFetch(path, {
        method: record ? "PATCH" : "POST",
        body: JSON.stringify(payloadFor(section.key, draft)),
      });
      await onSaved();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <aside className="editor">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{record ? "EDIT" : "NEW"}</p>
          <h2>{record ? recordName(record) : `Add ${section.singular}`}</h2>
        </div>
        <button className="text-button" onClick={onCancel}>
          Close
        </button>
      </div>
      <form onSubmit={submit} className="configuration-form">
        <Fields
          section={section.key}
          configuration={configuration}
          draft={draft}
          update={update}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={Boolean(draft.isActive)}
            onChange={(event) => update("isActive", event.target.checked)}
          />{" "}
          Active configuration
        </label>
        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </aside>
  );
}

function Fields({
  section,
  configuration,
  draft,
  update,
}: {
  section: SectionKey;
  configuration: Configuration;
  draft: Draft;
  update: (key: string, value: string | boolean) => void;
}) {
  const text = (key: string, label: string, required = false) => (
    <label key={key}>
      {label}
      <input
        value={String(draft[key] ?? "")}
        onChange={(event) => update(key, event.target.value)}
        required={required}
      />
    </label>
  );
  const area = (key: string, label: string, hint?: string) => (
    <label key={key}>
      {label}
      {hint && <small>{hint}</small>}
      <textarea
        value={String(draft[key] ?? "")}
        onChange={(event) => update(key, event.target.value)}
        rows={
          key.includes("Guidance") ||
          key.includes("Rules") ||
          key.includes("Characteristics")
            ? 4
            : 2
        }
      />
    </label>
  );
  const capabilitySelect = (
    <label>
      Capability
      <select
        value={String(draft.capabilityId ?? "")}
        onChange={(event) => update("capabilityId", event.target.value)}
        required
      >
        <option value="">Select a capability</option>
        {configuration.capabilities.map((capability) => (
          <option key={capability.id} value={capability.id}>
            {capability.sector.name} / {capability.name}
          </option>
        ))}
      </select>
    </label>
  );
  if (section === "sectors")
    return (
      <>
        {text("name", "Sector name", true)}
        {area("description", "Description")}
        {area("terminology", "Terminology", "Comma-separated")}
        {area("geographies", "Geographies", "Comma-separated")}
        {area("negativeTerms", "Negative terms", "Comma-separated")}
        {area("researchRules", "Research rules", "Optional JSON object")}
      </>
    );
  if (section === "capabilities")
    return (
      <>
        {
          <label>
            Sector
            <select
              value={String(draft.sectorId ?? "")}
              onChange={(event) => update("sectorId", event.target.value)}
              required
            >
              <option value="">Select a sector</option>
              {configuration.sectors.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.name}
                </option>
              ))}
            </select>
          </label>
        }
        {text("name", "Capability name", true)}
        {area("description", "Description")}
        {area("businessProblems", "Business problems", "Comma-separated")}
        {area("businessValue", "Business value")}
        {area("searchGuidance", "Search guidance", "Optional JSON object")}
        {area("researchGuidance", "Research guidance", "Optional JSON object")}
      </>
    );
  if (section === "deliverables")
    return (
      <>
        {capabilitySelect}
        {text("name", "Deliverable name", true)}
        {area("description", "Description")}
      </>
    );
  if (section === "targetProfiles")
    return (
      <>
        {capabilitySelect}
        {text("name", "Target-client profile name", true)}
        {area(
          "companyCharacteristics",
          "Company characteristics",
          "Optional JSON object",
        )}
        {text("minimumEmployees", "Minimum employees")}
        {text("maximumEmployees", "Maximum employees")}
        {area("geographies", "Geographies", "Comma-separated")}
        {area("positiveTerms", "Positive terms", "Comma-separated")}
        {area("negativeTerms", "Negative terms", "Comma-separated")}
        {area("typicalBusinessModel", "Typical business model")}
        {area("outsourcingCharacteristics", "Outsourcing characteristics")}
      </>
    );
  return (
    <>
      {capabilitySelect}
      {text("title", "Decision-maker title", true)}
      {text("priority", "Priority", true)}
      {area("seniorities", "Seniorities", "Comma-separated")}
      {area("positiveTerms", "Positive terms", "Comma-separated")}
      {area("negativeTerms", "Negative terms", "Comma-separated")}
    </>
  );
}
