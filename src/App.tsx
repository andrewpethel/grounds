import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ev2ServiceGroups,
  serviceByName,
  services,
  serviceValidationByPath,
  srmObservations,
  teamsIntelligence,
} from "./data";
import { DeploymentDiffsPage } from "./DeploymentDiffsPage";
import {
  DeploymentsPage,
  DomainDeploymentsPage,
} from "./DeploymentsDrawer";
import { GitHistoryPage } from "./GitHistoryPage";
import { LocalReposPage } from "./LocalReposPage";
import { DailyReportPage } from "./DailyReportPage";
import { FlowsPage } from "./FlowsPage";
import { WorkItemsPage } from "./WorkItemsPage";
import { WorkDrawer } from "./WorkDrawer";
import { NotesPage } from "./NotesPage";
import { ServiceChatPage } from "./ServiceChatPage";
import { vscodeFileUri } from "./links";
import { readBrowserCache, writeBrowserCache } from "./browserCache";
import type {
  CatalogService,
  Dependency,
  Environment,
  OperationalChannel,
  Pipeline,
  Repository,
  ResourceLink,
  ServiceDomain,
  ServiceValidation,
} from "./types";

const domainLabels: Record<ServiceDomain, string> = {
  "control-plane": "Control plane",
  "data-plane": "Data plane",
  "alerts-management": "Alerts management",
  aiops: "AIOps",
};

const domainOrder: ServiceDomain[] = [
  "control-plane",
  "data-plane",
  "alerts-management",
  "aiops",
];

function formatEnvironmentLabel(cloud: string) {
  if (cloud === "ussec") return "USSec";
  if (cloud === "usnat") return "USNat";
  if (cloud === "govsg") return "GovSG";
  return formatLabel(cloud);
}

function isActiveSrmStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return (
    normalized.includes("pending") ||
    normalized.includes("processing") ||
    normalized.includes("progress") ||
    normalized.includes("running")
  );
}

const srmRootUrl = "https://srm.azure.com/#/";
const srmReleasePinsStorageKey = "grounds-srm-release-pins";
const previouslyPinnedRetentionMilliseconds = 30 * 24 * 60 * 60 * 1000;

interface SrmReleasePin {
  pinnedAt: string;
  releaseId: string;
  serviceGroupId: string;
  serviceName: string;
  unpinnedAt?: string;
}

interface RepositoryOnboardingAnalysis {
  canonicalUrl: string;
  defaultBranch: string;
  description: string;
  displayName: string;
  name: string;
  organization: string;
  pipelineFiles: string[];
  project?: string;
  provider: Repository["provider"];
  serviceName: string;
  warnings: string[];
}

function loadSrmReleasePins() {
  const stored = window.localStorage.getItem(srmReleasePinsStorageKey);
  if (!stored) {
    return srmObservations.releases.map((release) => ({
      pinnedAt: release.observedAt,
      releaseId: release.releaseId,
      serviceGroupId: release.serviceGroupId ?? "",
      serviceName: release.serviceName,
    }));
  }

  try {
    const cutoff = Date.now() - previouslyPinnedRetentionMilliseconds;
    return (JSON.parse(stored) as SrmReleasePin[]).filter(
      (pin) =>
        !pin.unpinnedAt || new Date(pin.unpinnedAt).valueOf() >= cutoff,
    );
  } catch {
    return [];
  }
}

const ev2Clouds = [
  {
    cloud: "public",
    domain: "net",
    label: "Public",
    network: "Public network",
  },
  {
    cloud: "ussec",
    domain: "microsoft.scloud",
    label: "USSec",
    network: "Air-gapped network",
  },
  {
    cloud: "usnat",
    domain: "eaglex.ic.gov",
    label: "USNat",
    network: "Air-gapped network",
  },
] as const;

type TextSize = 0 | 1 | 2;
type ColorMode = "dark" | "light";
type AppPage =
  | "catalog"
  | "notes"
  | "git-history"
  | "local-repos"
  | "daily-report"
  | "flows"
  | "work-items"
  | "deployment-diffs"
  | "domain-deployments"
  | "about"
  | "docs"
  | "accessibility";

const textSizeLabels = ["Normal", "Medium", "Large"] as const;
const textSizeRootValues = ["16px", "18px", "20px"] as const;
type OperationalImpactTier = NonNullable<
  CatalogService["service"]["operationalImpactTier"]
>;

const operationalImpactCriteria: Array<{
  tier: OperationalImpactTier;
  blastRadius: string;
  dependencyFanOut: string;
  notificationPath: string;
  recoveryUrgency: string;
}> = [
  {
    tier: "critical",
    blastRadius: "Broad, multi-tenant, multi-region, or platform-wide customer impact.",
    dependencyFanOut: "Shared dependency for several production services or alert types.",
    notificationPath: "Blocks a core evaluation, ingestion, routing, query, or delivery stage.",
    recoveryUrgency: "Immediate restoration; sustained interruption is unacceptable.",
  },
  {
    tier: "high",
    blastRadius: "Major customer cohort, region, or alerting scenario is unavailable.",
    dependencyFanOut: "Multiple production components rely on the service.",
    notificationPath: "Severely degrades a major stage with limited workarounds.",
    recoveryUrgency: "Restore within the current operational shift.",
  },
  {
    tier: "medium",
    blastRadius: "Contained workload, feature, or customer segment is affected.",
    dependencyFanOut: "Few downstream dependencies and limited propagation.",
    notificationPath: "Partial degradation with a practical workaround or fallback.",
    recoveryUrgency: "Restore within the next business day.",
  },
  {
    tier: "low",
    blastRadius: "Internal, non-production, or narrowly isolated impact.",
    dependencyFanOut: "No material production dependency fan-out.",
    notificationPath: "Does not block customer notification or alert evaluation.",
    recoveryUrgency: "Planned restoration is acceptable.",
  },
];

function OperationalImpactTierButton({
  service,
  detail = false,
}: {
  service: CatalogService;
  detail?: boolean;
}) {
  const tier = service.service.operationalImpactTier ?? "medium";
  const impact = service.operationalImpact;
  const dependencies = service.dependencies ?? [];
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeModal() {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return;

    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeModal();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={`operational-impact-tier ${tier} ${detail ? "detail" : ""}`}
        onClick={() => setOpen(true)}
        ref={triggerRef}
        title={`View operational impact for ${service.service.displayName}`}
        type="button"
      >
        {detail ? `${formatLabel(tier)} impact tier` : tier}
        <Icon name="info" size={detail ? 13 : 11} />
      </button>
      {open && (
        <div className="impact-tier-layer">
          <button
            aria-label="Close operational impact tier information"
            className="impact-tier-backdrop"
            onClick={closeModal}
            type="button"
          />
          <section
            aria-labelledby="impact-tier-title"
            aria-modal="true"
            className="impact-tier-dialog"
            role="dialog"
          >
            <header>
              <div>
                <span className="eyebrow">Operator guidance</span>
                <h2 id="impact-tier-title">
                  Operational impact: {service.service.displayName}
                </h2>
              </div>
              <button
                aria-label="Close operational impact tier information"
                onClick={closeModal}
                ref={closeButtonRef}
                type="button"
              >
                <Icon name="close" />
              </button>
            </header>
            <p>
              {impact.summary}
            </p>
            <div className="impact-tier-current">
              <span>Current assessment</span>
              <strong className={`operational-impact-tier ${tier}`}>
                {formatLabel(tier)}
              </strong>
            </div>
            <div className="impact-profile-grid">
              <section>
                <span>Customer blast radius</span>
                <p>{impact.customerBlastRadius}</p>
              </section>
              <section>
                <span>Dependency fan-out</span>
                <p>{impact.dependencyFanOut}</p>
              </section>
              <section>
                <span>Notification-path role</span>
                <p>{impact.notificationPathImpact}</p>
              </section>
              <section>
                <span>Recovery urgency</span>
                <p>{impact.recoveryUrgency}</p>
              </section>
            </div>
            <section className="impact-systems">
              <h3>Affected services and systems</h3>
              <div>
                {impact.affectedSystems.map((system) => (
                  <span key={system}>{system}</span>
                ))}
              </div>
            </section>
            <section className="impact-dependencies">
              <h3>Recorded dependency chain</h3>
              {dependencies.length === 0 ? (
                <p>
                  No explicit dependency records are currently cataloged. Use
                  the affected-system profile above while the service owner
                  completes dependency mapping.
                </p>
              ) : (
                <ul>
                  {dependencies.map((dependency) => (
                    <li key={`${dependency.direction}-${dependency.service}`}>
                      <span>{formatLabel(dependency.direction)}</span>
                      <strong>{dependency.service}</strong>
                      <p>{dependency.purpose}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <details className="impact-tier-rubric">
              <summary>How Grounds assigns operational impact tiers</summary>
              <p>
                The tier estimates potential outage impact, not current service
                health or incident severity.
              </p>
              <div className="impact-tier-table-wrap">
                <table className="impact-tier-table">
                  <thead>
                    <tr>
                      <th>Tier</th>
                      <th>Customer blast radius</th>
                      <th>Dependency fan-out</th>
                      <th>Notification-path importance</th>
                      <th>Recovery urgency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operationalImpactCriteria.map((criterion) => (
                      <tr
                        className={criterion.tier === tier ? "current" : ""}
                        key={criterion.tier}
                      >
                        <th>{formatLabel(criterion.tier)}</th>
                        <td>{criterion.blastRadius}</td>
                        <td>{criterion.dependencyFanOut}</td>
                        <td>{criterion.notificationPath}</td>
                        <td>{criterion.recoveryUrgency}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <section className="impact-tier-authority">
              <h3>Authority and source of truth</h3>
              <p>
                <strong>Current source:</strong> the service-owner-maintained
                Grounds catalog record. Grounds uses Service Tree only for
                service identity and does not currently import this tier from
                Service Tree.
              </p>
              <p>
                If Service Tree exposes an approved business-criticality or
                service-tier field, that field should become authoritative.
                Until then, the owning service team is responsible for applying
                this rubric and reviewing the tier when architecture or
                dependencies change.
              </p>
            </section>
          </section>
        </div>
      )}
    </>
  );
}

function initialTextSize(): TextSize {
  const stored = window.localStorage.getItem("grounds-text-size");
  return stored === "1" || stored === "2" ? Number(stored) as TextSize : 0;
}

function initialColorMode(): ColorMode {
  return window.localStorage.getItem("grounds-color-mode") === "light"
    ? "light"
    : "dark";
}

function initialHighContrast() {
  return window.localStorage.getItem("grounds-high-contrast") === "true";
}

function initialHiddenServiceGroups() {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem("grounds-hidden-service-groups") ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

type IconName =
  | "accessibility"
  | "activity"
  | "arrow"
  | "bell"
  | "book"
  | "branch"
  | "check"
  | "chevron"
  | "cloud"
  | "close"
  | "code"
  | "copy"
  | "control"
  | "database"
  | "docs"
  | "edit"
  | "external"
  | "info"
  | "layers"
  | "menu"
  | "notes"
  | "pipeline"
  | "refresh"
  | "search"
  | "service"
  | "sparkles"
  | "warning";

function Icon({
  className = "",
  name,
  size = 18,
}: {
  className?: string;
  name: IconName;
  size?: number;
}) {
  const paths: Record<IconName, ReactNode> = {
    accessibility: (
      <>
        <circle cx="12" cy="4" r="2" />
        <path d="M5 8h14M12 6v14m0-7-5 7m5-7 5 7" />
      </>
    ),
    activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    arrow: <path d="m5 12 7-7 7 7M12 5v14" />,
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    book: (
      <>
        <path d="M4 5a3 3 0 0 1 3-3h5v18H7a3 3 0 0 0-3 2Z" />
        <path d="M20 5a3 3 0 0 0-3-3h-5v18h5a3 3 0 0 1 3 2Z" />
      </>
    ),
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="6" cy="19" r="2" />
        <path d="M6 7v10M8 7c5 0 3-1 8-1" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    cloud: <path d="M7 18h11a4 4 0 0 0 .4-8 7 7 0 0 0-13.2-2A5 5 0 0 0 7 18Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    code: <path d="m8 9-3 3 3 3m8-6 3 3-3 3m-3-9-2 12" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    control: (
      <>
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="8" cy="17" r="2" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
    docs: (
      <>
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M14 3v5h5M9 13h6M9 17h6" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </>
    ),
    external: <path d="M14 4h6v6m0-6-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5z" />
        <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    notes: (
      <>
        <path d="M7 3h10v4H7z" />
        <path d="M5 5h14v16H5zM8 11h8M8 15h8" />
      </>
    ),
    pipeline: (
      <>
        <circle cx="5" cy="5" r="2" />
        <circle cx="19" cy="5" r="2" />
        <circle cx="12" cy="19" r="2" />
        <path d="M7 5h10M6 7l5 10m7-10-5 10" />
      </>
    ),
    refresh: <path d="M20 6v5h-5M4 18v-5h5m10-2a7 7 0 0 0-12-4L4 11m16 2-3 4a7 7 0 0 1-12-4" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    service: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    sparkles: (
      <>
        <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z" />
        <path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" />
      </>
    ),
    warning: (
      <>
        <path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4m0 3h.01" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className={`icon ${className}`.trim()}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}

const domainIcons: Record<ServiceDomain, IconName> = {
  "control-plane": "control",
  "data-plane": "activity",
  "alerts-management": "bell",
  aiops: "sparkles",
};

function About() {
  return (
    <main className="content about-content">
      <section className="about-hero">
        <span className="eyebrow">About Grounds</span>
        <h1>Service context, assembled for operators.</h1>
        <p>
          Grounds is a schema-backed service JSON reader for Azure Monitor Alerts.
          It turns distributed repository and deployment metadata into a consistent,
          searchable operational catalog.
        </p>
        <p className="about-tagline">
          Grounds Display empowers you to dig deeper and grow your understanding.
        </p>
      </section>

      <section className="about-grid" aria-label="How Grounds works">
        <article className="about-card">
          <span className="resource-icon"><Icon name="docs" /></span>
          <div>
            <h2>JSON-driven catalog</h2>
            <p>
              Each service is represented by a JSON record covering ownership,
              repositories, pipelines, environments, dependencies, resources,
              dashboards, and known issues.
            </p>
          </div>
        </article>
        <article className="about-card">
          <span className="resource-icon"><Icon name="check" /></span>
          <div>
            <h2>Schema-backed consistency</h2>
            <p>
              Records are validated against <code>service_schema.json</code>. The
              application loads every service record at build time and presents the
              same structure across all service domains.
            </p>
          </div>
        </article>
        <article className="about-card">
          <span className="resource-icon"><Icon name="code" /></span>
          <div>
            <h2>Local repository context</h2>
            <p>
              Cataloged checkout paths enable copy and VS Code launch actions. Grounds
              does not modify repositories or execute Git commands; VS Code must be
              installed and registered for protocol links.
            </p>
          </div>
        </article>
        <article className="about-card">
          <span className="resource-icon"><Icon name="cloud" /></span>
          <div>
            <h2>Declared versus live state</h2>
            <p>
              Environment coverage is derived from enlisted EV2 configuration.
              Runtime health, successful build versions, and deployed versions require
              live Azure DevOps, EV2, or monitoring integrations.
            </p>
          </div>
        </article>
      </section>

      <section className="about-boundary">
        <div>
          <span className="eyebrow">Current boundary</span>
          <h2>Catalog records remain separate from local operator work.</h2>
        </div>
        <p>
          Service JSON files remain the catalog source of truth. Notes, board settings,
          and created-work-item references stay in the operator&apos;s local Grounds
          database and do not modify service repositories.
        </p>
      </section>
    </main>
  );
}

function Accessibility({
  colorMode,
  highContrast,
  onColorModeChange,
  onHighContrastChange,
  onTextSizeChange,
  textSize,
}: {
  colorMode: ColorMode;
  highContrast: boolean;
  onColorModeChange: (mode: ColorMode) => void;
  onHighContrastChange: (enabled: boolean) => void;
  onTextSizeChange: (size: TextSize) => void;
  textSize: TextSize;
}) {
  return (
    <main className="content accessibility-content">
      <section className="about-hero">
        <span className="eyebrow">Accessibility</span>
        <h1>Adjust Grounds for comfortable reading.</h1>
        <p>
          Choose the text size and visual appearance that work best for you. Your
          preferences are applied throughout Grounds and saved on this device.
        </p>
      </section>

      <fieldset className="text-size-options">
        <legend>Text size</legend>
        {textSizeLabels.map((label, value) => {
          const size = value as TextSize;
          return (
            <label
              className={`text-size-option ${textSize === size ? "selected" : ""}`}
              key={label}
            >
              <input
                checked={textSize === size}
                name="grounds-text-size"
                onChange={() => onTextSizeChange(size)}
                type="radio"
                value={size}
              />
              <span className={`text-size-preview text-size-preview-${size}`}>Aa</span>
              <span>
                <strong>{label}</strong>
                <small>{textSizeRootValues[size]} base text</small>
              </span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="display-mode-options">
        <legend>Color mode</legend>
        {(["dark", "light"] as const).map((mode) => (
          <label
            className={`display-mode-option ${colorMode === mode ? "selected" : ""}`}
            key={mode}
          >
            <input
              checked={colorMode === mode}
              name="grounds-color-mode"
              onChange={() => onColorModeChange(mode)}
              type="radio"
              value={mode}
            />
            <span className={`theme-preview theme-preview-${mode}`} aria-hidden="true">
              <span />
              <span />
            </span>
            <span>
              <strong>{mode === "dark" ? "Dark" : "Light"}</strong>
              <small>
                {mode === "dark"
                  ? "Dark surfaces with light text"
                  : "Light surfaces with dark text"}
              </small>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="contrast-setting" aria-labelledby="contrast-setting-title">
        <div>
          <h2 id="contrast-setting-title">High contrast</h2>
          <p>Increase text, border, focus, and control contrast throughout Grounds.</p>
        </div>
        <label className="switch-control">
          <input
            aria-label="High contrast"
            checked={highContrast}
            onChange={(event) => onHighContrastChange(event.target.checked)}
            type="checkbox"
          />
          <span aria-hidden="true" />
          <span>{highContrast ? "On" : "Off"}</span>
        </label>
      </section>
    </main>
  );
}

const docsTopics: Array<{
  id: string;
  eyebrow: string;
  title: string;
  searchText: string;
  content: ReactNode;
}> = [
  {
    id: "service-groups",
    eyebrow: "EV2",
    title: "Service Groups",
    searchText:
      "EV2 Service Groups discovery ownership repository associations hidden groups environments SRM stages",
    content: (
      <>
        <p>
          A Service Tree can contain several independently deployable EV2 Service
          Groups. Grounds discovers those groups from EV2 and uses repository
          deployment configuration to associate a group with a catalog service.
          These associations are internal organization metadata, not deployment
          health, so Grounds does not display mapping-status badges on operator
          cards.
        </p>
        <p>
          A group without repository evidence is still available for deployment
          searches and note tags. Grounds simply avoids guessing which catalog
          service owns it. Hidden groups are a per-browser display preference and
          do not delete EV2 observations.
        </p>
        <p>
          Grounds automatically queries the authenticated SRM Kusto database when
          a service page opens. Environment chips and current statuses use exact
          Service Group matches from that live result, supplemented by locally
          captured release-stage evidence. No chip means neither source currently
          contains a status for that environment; it does not mean the Service
          Group cannot deploy there.
        </p>
      </>
    ),
  },
  {
    id: "srm-refresh",
    eyebrow: "Service Release Manager",
    title: "Pin detailed deployment observations from SRM",
    searchText:
      "SRM refresh release deployment observations Edge authentication Service Tree status stages service group troubleshooting",
    content: (
      <>
        <p>
          Current Service Group status loads automatically from Kusto. Pinning an
          SRM release is an optional Service Group action for preserving richer
          release and stage evidence locally. Open a service, find the relevant
          EV2 Service Group card, and select <strong>Pin SRM release</strong>.
          The dialog displays that Service Group as read-only so the captured
          release cannot accidentally be attached to another group.
        </p>
        <ol className="docs-steps">
          <li>
            Copy the release-status URL from SRM or Bridge and paste it into the
            dialog.
          </li>
          <li>
            Confirm the read-only Service Group name and ID match the deployment
            you are inspecting.
          </li>
          <li>
            Select <strong>Open Edge and pin</strong>. Complete interactive
            sign-in in the dedicated Grounds Edge window if prompted.
          </li>
          <li>
            Keep the window open while Grounds reads the release response. After
            capture, Grounds pins and displays the normalized release, stage,
            environment, and status observations on the same Service Group card.
          </li>
        </ol>
        <p>
          Grounds accepts only HTTPS release URLs from <code>srm.azure.com</code>{" "}
          or <code>bridge.azure.com</code>. The local companion verifies that the
          release&apos;s Service Tree ID matches the current catalog service,
          validates the normalized observation against the SRM schema, and writes
          the detailed observation atomically to{" "}
          <code>intelligence\srm\release-observations.json</code>.
        </p>
        <p>
          Pins are a per-browser preference. A release remains pinned until it is
          unpinned. Unpinned releases remain visible as previously pinned for 30
          days, during which they can be reviewed or pinned again.
        </p>
        <aside className="docs-callout">
          <strong>Authentication and data boundary</strong>
          <p>
            The Edge profile is stored locally for reuse. Grounds does not export
            browser cookies or credentials, and the browser operation is available
            only through the local development companion. Captured deployment
            metadata is an observation, not a live health guarantee.
          </p>
        </aside>
        <p>
          If refresh fails, verify that the URL is a release-status URL, the
          signed-in identity can access that release, and the release belongs to
          the Service Tree shown on the service page. Grounds also permits only one
          browser-assisted operation at a time.
        </p>
      </>
    ),
  },
  {
    id: "teams-links",
    eyebrow: "Microsoft Teams",
    title: "Operational channels and source messages",
    searchText:
      "Microsoft Teams operational channels deployment intelligence canonical links source messages permalinks",
    content: (
      <p>
        Operational channel links are canonical service-team destinations stored
        in each service record. Teams deployment intelligence retains separate
        source-message permalinks so operators can inspect the exact conversation
        evidence without confusing it with the service&apos;s deployment channel.
      </p>
    ),
  },
  {
    id: "work",
    eyebrow: "Local workspace",
    title: "Work notes",
    searchText:
      "work notes local workspace tags Service Groups SQLite grounds database",
    content: (
      <>
        <p>
          The Work button opens notes scoped to the current service. Notes can be
          tagged with any discovered Service Group under that service&apos;s Service
          Tree. Grounds stores notes and per-service board endpoints in the local{" "}
          <code>.grounds\grounds.db</code> SQLite database; this data is not added
          to service JSON files or committed to source control.
        </p>
        <p>
          The <strong>Notes</strong> page in the main navigation provides a
          catalog-wide workspace for saved notes. Operators can search and filter
          notes, create records for any catalog service, edit content and
          Service-Group tags, open the associated service, or delete records.
          Changes made there are immediately available in the service-level Work
          drawer.
        </p>
        <p>
          Pasting an Azure DevOps team board URL into the Work drawer resolves
          the team&apos;s allowed Area Paths, all configured Iteration Paths,
          and the team defaults through the signed-in Azure CLI identity.
          Grounds presents those values as selectors when creating a work item;
          the catalog-wide <strong>Work items</strong> page also supports Area
          Path and Iteration Path filters.
        </p>
      </>
    ),
  },
  {
    id: "work-items",
    eyebrow: "Azure DevOps ownership",
    title: "Work items",
    searchText:
      "Azure DevOps work items assigned owned user stories tasks bugs features Area Path Iteration Path Azure CLI",
    content: (
      <>
        <p>
          The <strong>Work items</strong> page uses the signed-in Azure CLI
          identity to retrieve items assigned to the user from each unique Azure
          DevOps organization and project discovered through catalog repository
          URLs. Grounds batches item details, caches results for five minutes,
          and reports inaccessible projects as partial failures.
        </p>
        <p>
          The default view shows actionable assignments and excludes Done,
          Closed, Resolved, and Removed states. Completed assignments remain
          available through the history filter with search by title, ID, type,
          Area Path, Iteration Path, project, or tag. Grounds does not persist
          Azure DevOps tokens or work-item content.
        </p>
        <p>
          An additional team board URL can be supplied on the page to include a
          project that is not represented by an enlisted repository. Each loaded
          endpoint becomes a persistent board chip; selecting a chip queries and
          displays that board project independently. The URL list is retained in
          local browser settings, while authentication and queries remain in the
          local server companion.
        </p>
      </>
    ),
  },
  {
    id: "git-history",
    eyebrow: "Engineering activity",
    title: "Git history",
    searchText:
      "Git history Azure DevOps pull requests PRs commits authored reviewed repositories Azure CLI",
    content: (
      <>
        <p>
          The <strong>Git history</strong> page uses the signed-in Azure CLI
          identity to retrieve authored commits plus authored or reviewed pull
          requests from Azure DevOps repositories enlisted in the Grounds service
          catalog. Grounds does not scan unrelated repositories or persist Azure
          DevOps credentials.
        </p>
        <p>
          Activity can be filtered by time range, type, association, repository,
          title, branch, or related Grounds service. Results are cached locally in
          the running development server for five minutes; <strong>Refresh history</strong>{" "}
          bypasses that cache. Repository access failures are reported as partial
          results instead of hiding activity returned by accessible repositories.
        </p>
      </>
    ),
  },
  {
    id: "deployment-diffs",
    eyebrow: "Build and deployment evidence",
    title: "Deployment diffs",
    searchText:
      "deployment diffs builds current previous Azure DevOps commits changed files USSec USNat Fairfax AGC SRM evidence lineage impact",
    content: (
      <>
        <p>
          The <strong>Deployment diffs</strong> page resolves each cataloged
          Azure DevOps build definition, retrieves its latest two successful
          completed builds, and compares their exact source commits. Definition
          IDs are used when available; otherwise Grounds resolves YAML-backed
          definitions from the cataloged repository and pipeline-file path.
        </p>
        <p>
          Changed paths are prioritized when they reference USSec, USNat, or
          Fairfax and when they fall under repository paths cataloged for the
          service. Grounds also highlights deployment, rollout, manifest,
          identity, certificate, network, regional, and configuration paths.
          Potential-impact labels are operator guidance derived from those paths
          and the service&apos;s operational-impact profile, not a live health or
          guaranteed blast-radius assessment.
        </p>
        <aside className="docs-callout">
          <strong>Build evidence is not deployment lineage</strong>
          <p>
            A successful build does not prove that its artifact reached an
            environment. Grounds displays pinned SRM releases and sovereign
            stages separately until release metadata proves that both compared
            builds were deployed. Services with an unresolved definition or
            fewer than two successful builds remain visible with an explicit
            configuration status instead of falling back to repository commits.
          </p>
        </aside>
        <p>
          Results use the signed-in Azure CLI identity, remain in the local
          development companion, and are cached for five minutes.{" "}
          <strong>Refresh comparisons</strong> bypasses that cache.
        </p>
      </>
    ),
  },
  {
    id: "ado",
    eyebrow: "Azure DevOps",
    title: "Creating work items",
    searchText:
      "Azure DevOps ADO work items Task Bug User Story Issue Azure CLI access token process template",
    content: (
      <>
        <p>
          Grounds saves the note before creating a Task, Bug, User Story, or Issue.
          The local companion requests an Azure DevOps access token from the Azure
          CLI, creates the item through the Work Item Tracking REST API, and stores
          only the resulting work-item reference. Access tokens never enter the
          browser or the SQLite database.
        </p>
        <p>
          Work settings can also provide an exact Area Path and Iteration Path for
          board placement. Enable <strong>Assign to me</strong> to resolve the
          authenticated Azure DevOps identity from the current Azure CLI token and
          set the work item&apos;s Assigned To field. These choices are stored
          locally per Grounds service.
        </p>
        <p>
          Paste a team board URL containing{" "}
          <code>/_boards/board/t/&#123;team&#125;/...</code> to have Grounds query
          that team&apos;s default Area Path and current Iteration Path. Grounds
          resolves the paths automatically on paste; the adjacent resolve button
          supports typed URLs and retries. Either field can still be edited
          manually before creating the item.
        </p>
        <p>
          Run <code>az login</code> with an identity that can create work items in
          the target project. Available work-item types depend on that project&apos;s
          process template.
        </p>
      </>
    ),
  },
];

function Docs() {
  const [docsQuery, setDocsQuery] = useState("");
  const initialTopicId =
    window.location.hash.match(/^#\/docs\/([^/?#]+)/)?.[1] ??
    docsTopics[0].id;
  const [activeTopicId, setActiveTopicId] = useState(initialTopicId);
  const normalizedQuery = docsQuery.trim().toLowerCase();
  const visibleTopics = docsTopics.filter((topic) =>
    `${topic.eyebrow} ${topic.title} ${topic.searchText}`
      .toLowerCase()
      .includes(normalizedQuery),
  );

  useEffect(() => {
    const topicId = window.location.hash.match(/^#\/docs\/([^/?#]+)/)?.[1];
    if (!topicId) return;

    window.requestAnimationFrame(() => {
      document.getElementById(topicId)?.scrollIntoView({ block: "start" });
    });
  }, []);

  function navigateToTopic(topicId: string) {
    setActiveTopicId(topicId);
    window.history.replaceState(null, "", `#/docs/${topicId}`);
    document.getElementById(topicId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  return (
    <main className="content about-content docs-content">
      <section className="about-hero">
        <span className="eyebrow">Grounds documentation</span>
        <h1>Operator workflows and data boundaries.</h1>
        <p>
          Grounds combines declared service metadata, locally captured work, and
          authenticated deployment observations without treating them as the same
          source of truth.
        </p>
      </section>

      <div className="docs-layout">
        <aside className="docs-navigation">
          <div>
            <span className="eyebrow">Documentation index</span>
            <h2>Find a workflow</h2>
          </div>
          <label htmlFor="docs-search">Search documentation</label>
          <div className="docs-search-control">
            <Icon name="search" size={15} />
            <input
              id="docs-search"
              onChange={(event) => setDocsQuery(event.target.value)}
              placeholder="Search topics..."
              type="search"
              value={docsQuery}
            />
          </div>
          <span className="docs-result-count">
            {visibleTopics.length} of {docsTopics.length} topics
          </span>
          <nav aria-label="Documentation topics">
            {visibleTopics.map((topic) => (
              <button
                className={activeTopicId === topic.id ? "active" : ""}
                key={topic.id}
                onClick={() => navigateToTopic(topic.id)}
                type="button"
              >
                <span>{topic.eyebrow}</span>
                <strong>{topic.title}</strong>
              </button>
            ))}
          </nav>
        </aside>

        <div className="docs-sections">
          {visibleTopics.map((topic) => (
            <section className="docs-section" id={topic.id} key={topic.id}>
              <span className="eyebrow">{topic.eyebrow}</span>
              <h2>{topic.title}</h2>
              {topic.content}
            </section>
          ))}
          {visibleTopics.length === 0 && (
            <section className="docs-empty" role="status">
              <Icon name="search" size={20} />
              <h2>No documentation matched</h2>
              <p>Try a service, tool, or workflow name such as SRM or work items.</p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function formatLabel(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getEv2PortalLinks(service: CatalogService) {
  const serviceTreeId = service.service.serviceTreeId;
  if (!serviceTreeId) return [];

  const declaredClouds = new Set(
    service.environments?.map((environment) => environment.cloud),
  );

  return ev2Clouds
    .filter(({ cloud }) => declaredClouds.has(cloud))
    .map(({ cloud, domain, label, network }) => ({
      cloud,
      label,
      network,
      url: `https://ra.ev2portal.azure.${domain}/#/services/${encodeURIComponent(serviceTreeId)}/overview`,
      serviceGroupsUrl: `https://ra.ev2portal.azure.${domain}/#/services/${encodeURIComponent(serviceTreeId)}/servicegroups`,
    }));
}

function getSrmServiceGroupOptions(service: CatalogService) {
  return [
    ...new Map(
      ev2ServiceGroups.observations
        .filter(
          (observation) =>
            observation.serviceTreeId.toLowerCase() ===
            service.service.serviceTreeId?.toLowerCase(),
        )
        .flatMap((observation) => observation.serviceGroups)
        .map((group) => [group.serviceGroupId, group]),
    ).values(),
  ].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function initialServiceName() {
  const slug = window.location.hash.match(/^#\/service\/([^/]+)/)?.[1] ?? "";
  return services.find((service) => service.service.name === slug)?.service.name;
}

function initialServiceView() {
  if (window.location.hash.endsWith("/deployments")) return "deployments" as const;
  if (window.location.hash.endsWith("/troubleshoot")) return "troubleshoot" as const;
  return "overview" as const;
}

function initialPage(): AppPage {
  if (window.location.hash === "#/notes") return "notes";
  if (window.location.hash === "#/git-history") return "git-history";
  if (window.location.hash === "#/local-repos") return "local-repos";
  if (window.location.hash === "#/daily-report") return "daily-report";
  if (window.location.hash === "#/flows") return "flows";
  if (window.location.hash === "#/work-items") return "work-items";
  if (window.location.hash === "#/deployment-diffs") return "deployment-diffs";
  if (/^#\/domain\/[^/]+\/deployments$/.test(window.location.hash)) {
    return "domain-deployments";
  }
  if (window.location.hash === "#/about") return "about";
  if (window.location.hash === "#/accessibility") return "accessibility";
  if (window.location.hash.startsWith("#/docs")) return "docs";
  return "catalog";
}

function initialDeploymentDomain(): ServiceDomain {
  const domain = window.location.hash.match(
    /^#\/domain\/([^/]+)\/deployments$/,
  )?.[1];
  return domainOrder.includes(domain as ServiceDomain)
    ? (domain as ServiceDomain)
    : "control-plane";
}

function AppHeader({
  isNavigationOpen,
  isNarrow,
  onNavigationOpen,
  onHome,
  query,
  onQueryChange,
}: {
  isNavigationOpen: boolean;
  isNarrow: boolean;
  onNavigationOpen: () => void;
  onHome: () => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <header className="app-header">
      {isNarrow && (
        <button
          aria-controls="primary-navigation"
          aria-expanded={isNavigationOpen}
          aria-label="Open navigation"
          className="navigation-toggle"
          onClick={onNavigationOpen}
          type="button"
        >
          <Icon name="menu" />
        </button>
      )}
      <a
        className="brand"
        href="#"
        aria-label="Grounds home"
        onClick={(event) => {
          event.preventDefault();
          onHome();
        }}
      >
        <span className="brand-mark">
          <span />
          <span />
          <span />
        </span>
        <span>
          <strong>Grounds</strong>
          <small>Service operations</small>
        </span>
      </a>
      <label className="global-search">
        <Icon name="search" size={17} />
        <input
          aria-label="Search services"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search services, repositories, resources..."
          value={query}
        />
        <kbd>/</kbd>
      </label>
    </header>
  );
}

function Sidebar({
  activePage,
  activeDomain,
  isCollapsed,
  isNarrow,
  onAccessibility,
  onAbout,
  onCollapseToggle,
  onDocs,
  onDeploymentDiffs,
  onDomainChange,
  onGitHistory,
  onLocalRepos,
  onDailyReport,
  onFlows,
  onWorkItems,
  onNotes,
  onOverview,
}: {
  activePage: AppPage;
  activeDomain: ServiceDomain | "all";
  isCollapsed: boolean;
  isNarrow: boolean;
  onAccessibility: () => void;
  onAbout: () => void;
  onCollapseToggle: () => void;
  onDocs: () => void;
  onDeploymentDiffs: () => void;
  onDomainChange: (domain: ServiceDomain | "all") => void;
  onGitHistory: () => void;
  onLocalRepos: () => void;
  onDailyReport: () => void;
  onFlows: () => void;
  onWorkItems: () => void;
  onNotes: () => void;
  onOverview: () => void;
}) {
  return (
    <aside className="sidebar" id="primary-navigation">
      <button
        aria-label={
          isNarrow
            ? "Close navigation"
            : isCollapsed
              ? "Expand navigation"
              : "Collapse navigation"
        }
        className={`sidebar-toggle ${isCollapsed ? "collapsed" : ""}`}
        onClick={onCollapseToggle}
        type="button"
      >
        <Icon name={isNarrow ? "close" : "chevron"} />
        <span>
          {isNarrow ? "Close" : isCollapsed ? "Expand" : "Collapse"}
        </span>
      </button>
      <nav aria-label="Primary navigation">
        <button
          aria-label="Overview"
          className={`nav-item ${
            activePage === "catalog" && activeDomain === "all" ? "active" : ""
          }`}
          onClick={() => {
            onDomainChange("all");
            onOverview();
          }}
        >
          <Icon name="service" />
          <span>Overview</span>
          <span className="nav-count">{services.length}</span>
        </button>
        <p className="nav-label">Service domains</p>
        {domainOrder.map((domain) => {
          const count = services.filter((service) => service.domain === domain).length;
          return (
            <button
              aria-label={domainLabels[domain]}
              className={`nav-item ${
                activePage === "catalog" && activeDomain === domain ? "active" : ""
              }`}
              key={domain}
              onClick={() => {
                onDomainChange(domain);
                onOverview();
              }}
            >
              <Icon className={`domain-icon ${domain}`} name={domainIcons[domain]} />
              <span>{domainLabels[domain]}</span>
              <span className="nav-count">{count}</span>
            </button>
          );
        })}
        <p className="nav-label">Grounds</p>
        <button
          aria-label="Flows"
          className={`nav-item ${activePage === "flows" ? "active" : ""}`}
          onClick={onFlows}
        >
          <Icon name="pipeline" />
          <span>Flows</span>
        </button>
        <button
          aria-label="Notes"
          className={`nav-item ${activePage === "notes" ? "active" : ""}`}
          onClick={onNotes}
        >
          <Icon name="notes" />
          <span>Notes</span>
        </button>
        <button
          aria-label="Work items"
          className={`nav-item ${activePage === "work-items" ? "active" : ""}`}
          onClick={onWorkItems}
        >
          <Icon name="check" />
          <span>Work items</span>
        </button>
        <button
          aria-label="Git history"
          className={`nav-item ${activePage === "git-history" ? "active" : ""}`}
          onClick={onGitHistory}
        >
          <Icon name="branch" />
          <span>Git history</span>
        </button>
        <button
          aria-label="Local repos"
          className={`nav-item ${activePage === "local-repos" ? "active" : ""}`}
          onClick={onLocalRepos}
        >
          <Icon name="branch" />
          <span>Local repos</span>
        </button>
        <button
          aria-label="Deployment diffs"
          className={`nav-item ${
            activePage === "deployment-diffs" ? "active" : ""
          }`}
          onClick={onDeploymentDiffs}
        >
          <Icon name="pipeline" />
          <span>Deployment diffs</span>
        </button>
        <button
          aria-label="Daily AI report"
          className={`nav-item ${activePage === "daily-report" ? "active" : ""}`}
          onClick={onDailyReport}
        >
          <Icon name="sparkles" />
          <span>Daily report</span>
        </button>
        <button
          aria-label="Docs"
          className={`nav-item ${activePage === "docs" ? "active" : ""}`}
          onClick={onDocs}
        >
          <Icon name="book" />
          <span>Docs</span>
        </button>
        <button
          aria-label="About"
          className={`nav-item ${activePage === "about" ? "active" : ""}`}
          onClick={onAbout}
        >
          <Icon name="info" />
          <span>About</span>
        </button>
        <button
          aria-label="Accessibility"
          className={`nav-item ${activePage === "accessibility" ? "active" : ""}`}
          onClick={onAccessibility}
        >
          <Icon name="accessibility" />
          <span>Accessibility</span>
        </button>
      </nav>
      <div className="sidebar-footer">
        <div className="schema-status">
          <span className="schema-icon">
            <Icon name="check" size={15} />
          </span>
          <span>
            <strong>Schema valid</strong>
            <small>Version 1.0.0</small>
          </span>
        </div>
        <p>Grounds centralizes the context you need to operate Azure Alerts.</p>
      </div>
    </aside>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <article className="stat-card">
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function ServiceOnboardingDialog({ onClose }: { onClose: () => void }) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [analysis, setAnalysis] = useState<RepositoryOnboardingAnalysis>();
  const [domain, setDomain] = useState<ServiceDomain>("control-plane");
  const [serviceName, setServiceName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [serviceType, setServiceType] = useState("control-plane");
  const [lifecycle, setLifecycle] = useState("production");
  const [serviceTreeId, setServiceTreeId] = useState("");
  const [serviceGroupPatterns, setServiceGroupPatterns] = useState("");
  const [status, setStatus] = useState<"idle" | "analyzing" | "creating">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && status === "idle") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, status]);

  async function analyzeRepository(event: FormEvent) {
    event.preventDefault();
    setError("");
    setStatus("analyzing");
    try {
      const response = await fetch("/__grounds/service-onboarding/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Repository analysis failed.");
      const next = payload.analysis as RepositoryOnboardingAnalysis;
      setAnalysis(next);
      setRepositoryUrl(next.canonicalUrl);
      setServiceName(next.serviceName);
      setDisplayName(next.displayName);
      setDescription(next.description);
      setDefaultBranch(next.defaultBranch);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setStatus("idle");
    }
  }

  async function createService(event: FormEvent) {
    event.preventDefault();
    if (!analysis) return;
    setError("");
    setStatus("creating");
    try {
      const response = await fetch("/__grounds/service-onboarding/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultBranch,
          description,
          displayName,
          domain,
          lifecycle,
          pipelineFiles: analysis.pipelineFiles,
          repositoryUrl,
          serviceGroupPatterns,
          serviceName,
          serviceTreeId,
          serviceType,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Service creation failed.");
      window.location.hash = `/service/${payload.serviceName}`;
      window.location.reload();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("idle");
    }
  }

  return (
    <div className="service-onboarding-layer">
      <button
        aria-label="Close service onboarding"
        className="service-onboarding-backdrop"
        disabled={status !== "idle"}
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="service-onboarding-title"
        aria-modal="true"
        className="service-onboarding-dialog"
        role="dialog"
      >
        <header>
          <div>
            <span className="eyebrow">Catalog onboarding</span>
            <h2 id="service-onboarding-title">Add service from repository URL</h2>
            <p>
              Grounds analyzes remote metadata and creates a reviewable catalog record.
              The repository remains marked remote-only until a local checkout is enlisted.
            </p>
          </div>
          <button
            aria-label="Close service onboarding"
            disabled={status !== "idle"}
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        {!analysis ? (
          <form className="service-onboarding-url-form" onSubmit={analyzeRepository}>
            <label htmlFor="onboarding-repository-url">Azure DevOps or GitHub repository URL</label>
            <div>
              <input
                autoFocus
                id="onboarding-repository-url"
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://dev.azure.com/organization/project/_git/repository"
                required
                type="url"
                value={repositoryUrl}
              />
              <button disabled={status !== "idle"} type="submit">
                <Icon name="sparkles" size={15} />
                {status === "analyzing" ? "Analyzing..." : "Analyze repository"}
              </button>
            </div>
          </form>
        ) : (
          <form className="service-onboarding-review" onSubmit={createService}>
            <div className="onboarding-analysis-summary">
              <span className="checkout not-enlisted"><span /> Remote only</span>
              <div>
                <strong>{analysis.name}</strong>
                <small>{analysis.provider} · {analysis.defaultBranch}</small>
              </div>
              <button
                onClick={() => {
                  setAnalysis(undefined);
                  setError("");
                }}
                type="button"
              >
                Change URL
              </button>
            </div>
            <div className="service-onboarding-fields">
              <label>
                Service domain
                <select
                  onChange={(event) => {
                    const nextDomain = event.target.value as ServiceDomain;
                    setDomain(nextDomain);
                    setServiceType(
                      nextDomain === "alerts-management" ? "management" : nextDomain,
                    );
                  }}
                  value={domain}
                >
                  {domainOrder.map((candidate) => (
                    <option key={candidate} value={candidate}>{domainLabels[candidate]}</option>
                  ))}
                </select>
              </label>
              <label>
                Service type
                <select onChange={(event) => setServiceType(event.target.value)} value={serviceType}>
                  {["control-plane", "data-plane", "management", "monitoring", "frontend", "backend", "shared-platform", "other"].map((type) => (
                    <option key={type} value={type}>{formatLabel(type)}</option>
                  ))}
                </select>
              </label>
              <label>
                Stable service name
                <input
                  onChange={(event) => setServiceName(event.target.value)}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  required
                  value={serviceName}
                />
              </label>
              <label>
                Display name
                <input onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
              </label>
              <label>
                Default branch
                <input onChange={(event) => setDefaultBranch(event.target.value)} required value={defaultBranch} />
              </label>
              <label>
                Lifecycle
                <select onChange={(event) => setLifecycle(event.target.value)} value={lifecycle}>
                  {["development", "preview", "production", "deprecated", "retired"].map((value) => (
                    <option key={value} value={value}>{formatLabel(value)}</option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Description
                <textarea onChange={(event) => setDescription(event.target.value)} required rows={3} value={description} />
              </label>
              <label>
                Service Tree ID <small>Optional</small>
                <input onChange={(event) => setServiceTreeId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" value={serviceTreeId} />
              </label>
              <label>
                Service Group patterns <small>Optional, comma-separated</small>
                <input onChange={(event) => setServiceGroupPatterns(event.target.value)} placeholder=".ExampleService" value={serviceGroupPatterns} />
              </label>
            </div>
            {analysis.pipelineFiles.length > 0 && (
              <p className="onboarding-discovery-note">
                <Icon name="pipeline" size={14} />
                {analysis.pipelineFiles.length} pipeline file{analysis.pipelineFiles.length === 1 ? "" : "s"} discovered.
              </p>
            )}
            {analysis.warnings.map((warning) => (
              <p className="onboarding-warning" key={warning}><Icon name="warning" size={14} />{warning}</p>
            ))}
            <footer>
              <p>Operational impact is initialized as requiring owner review.</p>
              <button disabled={status !== "idle"} type="submit">
                <Icon name="check" size={15} />
                {status === "creating" ? "Creating service..." : "Create service"}
              </button>
            </footer>
          </form>
        )}
        {error && <p className="service-onboarding-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function ServiceCard({
  service,
  onSelect,
}: {
  service: CatalogService;
  onSelect: (service: CatalogService) => void;
}) {
  const issueCount = service.knownIssues.filter(
    (issue) => issue.status !== "resolved",
  ).length;
  const isLocallyEnlisted = service.repositories.some(
    (repository) =>
      repository.checkoutStatus === "available" && Boolean(repository.localPath),
  );
  return (
    <article className="service-card">
      <button
        aria-label={`Open ${service.service.displayName}`}
        className="service-card-open"
        onClick={() => onSelect(service)}
        type="button"
      >
        <div className="service-card-top">
        <span className={`service-glyph ${service.domain}`}>
          <Icon
            name={
              service.domain === "control-plane"
                ? "layers"
                : service.domain === "data-plane"
                  ? "database"
                  : service.domain === "aiops"
                    ? "cloud"
                    : "service"
            }
            size={20}
          />
        </span>
        </div>
        <div className="service-card-labels">
          <span className="service-domain">{domainLabels[service.domain]}</span>
          {!isLocallyEnlisted && (
            <span className="service-enlistment-chip">
              <span />
              Remote only
            </span>
          )}
        </div>
        <h3>{service.service.displayName}</h3>
        <p>{service.service.description}</p>
        <div className="card-tags">
          {(service.tags ?? []).slice(0, 3).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        <div className="service-card-footer">
          <span>
            <Icon name="code" size={15} />
            {service.repositories.length} repo
            {service.repositories.length === 1 ? "" : "s"}
          </span>
          <span className={issueCount ? "has-issues" : ""}>
            <Icon name={issueCount ? "warning" : "check"} size={15} />
            {issueCount ? `${issueCount} active` : "No active issues"}
          </span>
          <Icon name="chevron" size={17} />
        </div>
      </button>
      <span
        className={`operational-impact-tier ${
          service.service.operationalImpactTier ?? "medium"
        }`}
      >
        {service.service.operationalImpactTier ?? "medium"}
      </span>
    </article>
  );
}

function Overview({
  activeDomain,
  onDeployments,
  query,
  onSelect,
}: {
  activeDomain: ServiceDomain | "all";
  onDeployments: (domain: ServiceDomain) => void;
  query: string;
  onSelect: (service: CatalogService) => void;
}) {
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return services.filter((service) => {
      const inDomain = activeDomain === "all" || service.domain === activeDomain;
      if (!search) return inDomain;

      const searchable = [
        service.service.displayName,
        service.service.description,
        service.service.name,
        ...(service.tags ?? []),
        ...service.repositories.map((repository) => repository.name),
        ...(service.service.resourceTypes ?? []),
      ]
        .join(" ")
        .toLowerCase();

      return inDomain && searchable.includes(search);
    });
  }, [activeDomain, query]);

  const repositoryCount = new Set(
    services.flatMap((service) => service.repositories.map((repository) => repository.name)),
  ).size;
  const criticalImpactCount = services.filter(
    (service) => service.service.operationalImpactTier === "critical",
  ).length;
  const sovereignCount = services.filter(
    (service) =>
      service.environments?.some((environment) =>
        ["usnat", "ussec"].includes(environment.cloud),
      ) || service.tags?.includes("sovereign"),
  ).length;
  const localRepositoryCount = new Set(
    services.flatMap((service) =>
      service.repositories
        .filter(
          (repository) =>
            repository.checkoutStatus === "available" && repository.localPath,
        )
        .map((repository) => repository.name),
    ),
  ).size;

  return (
    <main className="content">
      {activeDomain === "all" && (
        <>
          <section className="hero">
            <div>
              <span className="eyebrow">Azure Monitor Alerts</span>
              <h1>Know the service.<br />Operate with context.</h1>
              <p>
                One place for service boundaries, source, deployments, dependencies,
                documentation, and operational state.
              </p>
            </div>
            <div className="hero-orbit" aria-hidden="true">
              <span className="orbit orbit-one" />
              <span className="orbit orbit-two" />
              <span className="orbit-core">
                <Icon name="service" size={30} />
              </span>
              <span className="orbit-node node-one" />
              <span className="orbit-node node-two" />
              <span className="orbit-node node-three" />
            </div>
          </section>

          <section className="stats-grid" aria-label="Catalog summary">
            <StatCard icon="service" label="Services" value={services.length} detail="Across 4 domains" />
            <StatCard
              icon="code"
              label="Repositories"
              value={repositoryCount}
              detail={`${localRepositoryCount} locally enlisted`}
            />
            <StatCard
              detail="Operational impact tier"
              icon="warning"
              label="Critical impact"
              value={criticalImpactCount}
            />
            <StatCard icon="cloud" label="Sovereign scope" value={sovereignCount} detail="USNat or USSec context" />
          </section>
        </>
      )}

      <section className="catalog-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Service catalog</span>
            <h2>
              {activeDomain === "all" ? "All services" : domainLabels[activeDomain]}
            </h2>
          </div>
          <div className="catalog-heading-actions">
            <span className="result-count">{filtered.length} results</span>
            <button
              className="catalog-onboarding-button"
              onClick={() => setIsOnboardingOpen(true)}
              type="button"
            >
              <Icon name="sparkles" size={15} />
              Add service
            </button>
            {activeDomain !== "all" && (
              <button
                className="catalog-deployments-button"
                onClick={() => onDeployments(activeDomain)}
                type="button"
              >
                <Icon name="pipeline" size={15} />
                Deployments
              </button>
            )}
          </div>
        </div>
        {filtered.length > 0 ? (
          <div className="service-grid">
            {filtered.map((service) => (
              <ServiceCard
                key={service.service.name}
                onSelect={onSelect}
                service={service}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="search" size={28} />
            <h3>No matching services</h3>
            <p>Try another service name, repository, resource type, or tag.</p>
          </div>
        )}
      </section>
      {isOnboardingOpen && (
        <ServiceOnboardingDialog onClose={() => setIsOnboardingOpen(false)} />
      )}
    </main>
  );
}

function Section({
  children,
  count,
  icon,
  title,
}: {
  children: ReactNode;
  count?: number;
  icon: IconName;
  title: string;
}) {
  return (
    <section className="detail-section">
      <div className="detail-section-title">
        <span><Icon name={icon} size={18} /></span>
        <h2>{title}</h2>
        {count !== undefined && <small>{count}</small>}
      </div>
      {children}
    </section>
  );
}

function ExternalLink({
  children,
  className = "",
  href,
}: {
  children: ReactNode;
  className?: string;
  href: string;
}) {
  return (
    <a className={className} href={href} rel="noreferrer" target="_blank">
      {children}
      <Icon name="external" size={14} />
    </a>
  );
}

function RepositoryCard({ repository }: { repository: Repository }) {
  const [copied, setCopied] = useState(false);

  async function copyPath() {
    if (!repository.localPath) return;
    await navigator.clipboard.writeText(repository.localPath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <article className="resource-card">
      <div className="resource-card-header">
        <span className="resource-icon"><Icon name="code" /></span>
        <div>
          <ExternalLink href={repository.url}>{repository.name}</ExternalLink>
          <p>{formatLabel(repository.purpose)}</p>
        </div>
        <span className={`checkout ${repository.checkoutStatus ?? "unknown"}`}>
          <span />
          {repository.checkoutStatus === "available" ? "Local" : "Remote"}
        </span>
      </div>
      <dl className="compact-list">
        <div>
          <dt>Branch</dt>
          <dd><Icon name="branch" size={14} />{repository.defaultBranch}</dd>
        </div>
        {repository.paths && repository.paths.length > 0 && (
          <div>
            <dt>Scope</dt>
            <dd>{repository.paths.join(", ")}</dd>
          </div>
        )}
        {repository.localPath && (
          <div>
            <dt>Checkout</dt>
            <dd className="path-value">
              <span>{repository.localPath}</span>
              <button aria-label="Copy checkout path" onClick={copyPath}>
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
            </dd>
          </div>
        )}
      </dl>
      <div className="repository-actions">
        <a
          className="open-repo-button"
          href={repository.url}
          rel="noreferrer"
          target="_blank"
          title={`Open ${repository.name} repository`}
        >
          <Icon name="external" size={15} />
          Open repository
        </a>
        {repository.checkoutStatus === "available" && repository.localPath && (
          <a
            className="open-repo-button"
            href={vscodeFileUri(repository.localPath)}
            title={`Open ${repository.name} in Visual Studio Code`}
          >
            <Icon name="code" size={15} />
            Open in VS Code
          </a>
        )}
      </div>
    </article>
  );
}

function PipelineCard({
  pipeline,
  stage,
}: {
  pipeline: Pipeline;
  stage: "Build" | "Release";
}) {
  return (
    <article className="resource-card pipeline-card">
      <div className="resource-card-header">
        <span className="resource-icon"><Icon name="pipeline" /></span>
        <div>
          <span className="minor-label">{stage} / {pipeline.provider}</span>
          <ExternalLink href={pipeline.url}>{pipeline.name}</ExternalLink>
        </div>
      </div>
      {pipeline.pipelineFile && (
        <code className="file-path">{pipeline.pipelineFile}</code>
      )}
      {pipeline.description && <p>{pipeline.description}</p>}
    </article>
  );
}

function DependencyCard({
  dependency,
  onNavigate,
}: {
  dependency: Dependency;
  onNavigate: (service: CatalogService) => void;
}) {
  const linkedService = serviceByName.get(dependency.service);
  return (
    <article className="dependency-card">
      <span className={`direction ${dependency.direction}`}>
        <Icon name="arrow" size={16} />
      </span>
      <div>
        <span className="minor-label">{formatLabel(dependency.direction)}</span>
        {linkedService ? (
          <button className="text-link" onClick={() => onNavigate(linkedService)}>
            {dependency.service}
            <Icon name="chevron" size={14} />
          </button>
        ) : (
          <strong>{dependency.service}</strong>
        )}
        <p>{dependency.purpose}</p>
        {dependency.failureImpact && (
          <small>Failure impact: {dependency.failureImpact}</small>
        )}
      </div>
    </article>
  );
}

function LinkCard({ link }: { link: ResourceLink }) {
  return (
    <ExternalLink className="link-card" href={link.url}>
      <span className="resource-icon"><Icon name="docs" /></span>
      <span>
        <small>{formatLabel(link.type)}</small>
        <strong>{link.title}</strong>
        {link.description && <p>{link.description}</p>}
      </span>
    </ExternalLink>
  );
}

function OperationalChannelCard({ channel }: { channel: OperationalChannel }) {
  return (
    <ExternalLink className="link-card" href={channel.url}>
      <span className="resource-icon"><Icon name="service" /></span>
      <span>
        <small>
          Microsoft Teams / {formatLabel(channel.purpose)}
        </small>
        <strong>{channel.name}</strong>
        {channel.description && <p>{channel.description}</p>}
      </span>
    </ExternalLink>
  );
}

const serviceGroupDescriptions: Record<string, string> = {
  "Microsoft.Azure.ADP.LSA.AUB":
    "Deploys authentication and bootstrap support used by the Log Search Alerts data plane.",
  "Microsoft.Azure.Alerts.AUB":
    "Deploys shared authentication and bootstrap resources used by Azure Alerts.",
  "Microsoft.Azure.AlertsDP.Infra":
    "Deploys the production infrastructure shared by Azure Alerts data-plane components.",
  "Microsoft.Azure.AlertsDP.Infra.Dev":
    "Deploys development infrastructure for Azure Alerts data-plane components.",
  "Microsoft.Azure.AlertsDP.Infra.PPE":
    "Deploys pre-production infrastructure for Azure Alerts data-plane components.",
  "Microsoft.Azure.AlertsDP.KustoToMetric":
    "Deploys the Kusto-to-Metrics processing service and its supporting resources.",
  "Microsoft.Azure.AlertsDP.LogSearchAlerts.Engine.Dev":
    "Deploys the development Log Search Alerts evaluation engine.",
  "Microsoft.Azure.AlertsDP.LSA":
    "Deploys the production Log Search Alerts evaluation service.",
  "Microsoft.Azure.AlertsDP.LSA.Dev":
    "Deploys the development Log Search Alerts evaluation service.",
  "Microsoft.Azure.AlertsDP.LSA.Int":
    "Deploys the integration environment for Log Search Alerts.",
  "Microsoft.Azure.AlertsDP.LSA.PPE":
    "Deploys the pre-production Log Search Alerts evaluation service.",
  "Microsoft.Azure.AlertsDP.LSA.PPE.PreBuildout":
    "Prepares regional resources before the Log Search Alerts PPE buildout.",
  "Microsoft.Azure.AlertsDP.LSA.PreBuildout":
    "Prepares regional resources before the production Log Search Alerts buildout.",
  "Microsoft.Azure.AlertsDP.Scheduler":
    "Deploys production scheduling and orchestration for alert evaluation.",
  "Microsoft.Azure.AlertsDP.Scheduler.Dev":
    "Deploys development scheduling and orchestration for alert evaluation.",
  "Microsoft.Azure.AlertsDP.Scheduler.PPE":
    "Deploys pre-production scheduling and orchestration for alert evaluation.",
  "Microsoft.Azure.Ev2.Tutorial.MOMALKA":
    "Runs an EV2 tutorial or validation deployment registered beneath this Service Tree.",
  "Microsoft.Azure.LogSearchAlerts.PlannedQuotaTest":
    "Runs planned-quota validation for Log Search Alerts.",
  "Microsoft.Azure.MicrosoftAzureLogSearchAlerts.AADFirstPartyGit":
    "Deploys first-party Microsoft Entra application configuration for Log Search Alerts.",
  "Microsoft.Azure.Monitor.LogSearchAlerts.Engine.Dev":
    "Deploys the Azure Monitor Log Search Alerts engine in development.",
  "Microsoft.Azure.Monitor.LogSearchAlerts.Engine.Int":
    "Deploys the Azure Monitor Log Search Alerts engine in integration.",
  "Microsoft.Azure.Monitor.LogSearchAlerts.Infra.Dev":
    "Deploys development infrastructure for the Azure Monitor Log Search Alerts engine.",
  "Microsoft.Azure.Monitor.LogSearchAlerts.Infra.PPE":
    "Deploys pre-production infrastructure for the Azure Monitor Log Search Alerts engine.",
  "Microsoft.Azure.Monitor.PrometheusAlerts":
    "Deploys the production Prometheus Alerts service.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.AadApp":
    "Deploys Microsoft Entra application resources used by Prometheus Alerts.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Adapter":
    "Deploys the adapter that connects Prometheus alert evaluation to Azure Alerts ingestion.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Global":
    "Deploys global resources shared by the Prometheus Alerts service.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Mon":
    "Deploys the monitoring environment for Prometheus Alerts.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Mon.Adapter":
    "Deploys the Prometheus Alerts adapter in the monitoring environment.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Mon.Ruler":
    "Deploys the Prometheus rule evaluator in the monitoring environment.",
  "Microsoft.Azure.Monitor.PrometheusAlerts.Ruler":
    "Deploys the Prometheus rule evaluator that executes alerting rules.",
  "Microsoft.AzureAlertsDataPlane.SubscriptionsCreation":
    "Provisions subscriptions and registrations required by Azure Alerts data-plane deployments.",
  "Microsoft.Azure.Alerts.ClopAgent.IndexUpdater":
    "Deploys the control-plane index updater agent used by Azure Alerts.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP":
    "Deploys the regional Azure Alerts resource-provider application.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.GlobalRP":
    "Deploys the global Azure Alerts resource-provider application.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.GlobalRP.Test":
    "Deploys the test instance of the global Azure Alerts resource provider.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.PartialManifest":
    "Publishes production ARM partial manifests for Azure Alerts resource types.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.PartialManifest.Canary":
    "Publishes canary ARM partial manifests before broader Azure Alerts rollout.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.PreBuildout":
    "Prepares regional resources before the Azure Alerts resource-provider buildout.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.PreBuildout.Test":
    "Runs pre-buildout preparation for Azure Alerts test deployments.",
  "Microsoft.Azure.AzureMetricAlerts.AlertsRP.Test":
    "Deploys the test instance of the regional Azure Alerts resource provider.",
  "Microsoft.Azure.AzureMetricAlerts.BennieBuildoutTest":
    "Runs a buildout validation deployment for the Azure Metric Alerts platform.",
  "Microsoft.Azure.AzureMetricAlerts.LAMetricIngestion":
    "Deploys Log Analytics Metric Ingestion processing and supporting resources.",
  "Microsoft.Azure.AzureMetricAlerts.LAMetricIngestion.PreBuildout":
    "Prepares regional resources before Log Analytics Metric Ingestion buildout.",
  "Microsoft.AzureMetricAlerts.SubscriptionsCreation":
    "Provisions subscriptions and registrations required by Azure Metric Alerts deployments.",
};

function describeServiceGroup(serviceGroupId: string) {
  return (
    serviceGroupDescriptions[serviceGroupId] ??
    "Deploys an independently managed EV2 unit beneath this service's Service Tree."
  );
}

const serviceGroupSearchThreshold = 7;

function ServiceGroupsSection({
  onPinSrmRelease,
  onOpenSrmRefresh,
  onUnpinSrmRelease,
  portalLinks,
  releasePins,
  service,
}: {
  onPinSrmRelease: (releaseId: string, serviceGroupId: string) => void;
  onOpenSrmRefresh: (serviceGroupId: string) => void;
  onUnpinSrmRelease: (releaseId: string, serviceGroupId: string) => void;
  portalLinks: ReturnType<typeof getEv2PortalLinks>;
  releasePins: SrmReleasePin[];
  service: CatalogService;
}) {
  const cachedSrmStatus = readBrowserCache<{
    generatedAt?: string;
    serviceGroups?: Array<{
      environment: string;
      releaseCorrelationId: string;
      releaseName: string;
      releaseUrl: string;
      serviceGroupName: string;
      serviceTreeId: string;
      status: string;
      updatedAt: string;
    }>;
  }>("srm-release-status");
  const cachedServiceStatuses = (cachedSrmStatus?.value.serviceGroups ?? [])
    .filter(
      (status) =>
        status.serviceTreeId.toLowerCase() ===
        service.service.serviceTreeId?.toLowerCase(),
    );
  const [selectedGroups, setSelectedGroups] = useState<Record<string, string>>(
    {},
  );
  const [serviceGroupQueries, setServiceGroupQueries] = useState<
    Record<string, string>
  >({});
  const [refreshingCloud, setRefreshingCloud] = useState<string>();
  const [refreshError, setRefreshError] = useState("");
  const [liveSrmStatuses, setLiveSrmStatuses] = useState<
    Array<{
      environment: string;
      releaseCorrelationId: string;
      releaseName: string;
      releaseUrl: string;
      serviceGroupName: string;
      status: string;
      updatedAt: string;
    }>
  >(cachedServiceStatuses);
  const [liveSrmLoading, setLiveSrmLoading] = useState(!cachedSrmStatus);
  const [liveSrmError, setLiveSrmError] = useState("");
  const [liveSrmGeneratedAt, setLiveSrmGeneratedAt] = useState(
    cachedSrmStatus?.value.generatedAt ?? "",
  );
  const [hiddenServiceGroups, setHiddenServiceGroups] = useState<string[]>(
    initialHiddenServiceGroups,
  );
  const reachablePortalLinks = portalLinks.filter(
    (portal) => portal.cloud === "public",
  );
  const observations = ev2ServiceGroups.observations.filter(
    (observation) =>
      observation.cloud === "public" &&
      observation.serviceTreeId.toLowerCase() ===
      service.service.serviceTreeId?.toLowerCase(),
  );
  const hiddenServiceGroupSet = new Set(hiddenServiceGroups);
  const groupPreferenceKey = (cloud: string, serviceGroupId: string) =>
    `${service.service.name}:${cloud}:${serviceGroupId}`;
  const hiddenGroups = observations.flatMap((observation) =>
    observation.serviceGroups
      .filter((group) =>
        hiddenServiceGroupSet.has(
          groupPreferenceKey(observation.cloud, group.serviceGroupId),
        ),
      )
      .map((group) => ({
        cloud: observation.cloud,
        group,
      })),
  );
  const totalGroups = observations.reduce(
    (total, observation) =>
      total +
      observation.serviceGroups.filter(
        (group) =>
          !hiddenServiceGroupSet.has(
            groupPreferenceKey(observation.cloud, group.serviceGroupId),
          ),
      ).length,
    0,
  );
  const serviceGroupReleases = srmObservations.releases.filter(
    (release) =>
      release.serviceName === service.service.name &&
      release.serviceGroupId &&
      releasePins.some(
        (pin) =>
          pin.serviceName === release.serviceName &&
          pin.serviceGroupId === release.serviceGroupId &&
          pin.releaseId === release.releaseId,
      ),
  );
  useEffect(() => {
    window.localStorage.setItem(
      "grounds-hidden-service-groups",
      JSON.stringify(hiddenServiceGroups),
    );
  }, [hiddenServiceGroups]);

  async function loadLiveSrmStatus(
    refresh = false,
    signal?: AbortSignal,
  ) {
    const serviceTreeId = service.service.serviceTreeId;
    if (!serviceTreeId) return;
    setLiveSrmLoading(true);
    setLiveSrmError("");
    try {
      const suffix = refresh ? "?refresh=true" : "";
      const response = await fetch(`/__grounds/srm-release-status${suffix}`, {
        signal,
      });
      const result = (await response.json()) as {
        error?: string;
        generatedAt?: string;
        serviceGroups?: Array<{
          environment: string;
          releaseCorrelationId: string;
          releaseName: string;
          releaseUrl: string;
          serviceGroupName: string;
          serviceTreeId: string;
          status: string;
          updatedAt: string;
        }>;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Live SRM status is unavailable.");
      }
      setLiveSrmStatuses(
        (result.serviceGroups ?? []).filter(
          (status) =>
            status.serviceTreeId.toLowerCase() ===
            serviceTreeId.toLowerCase(),
        ),
      );
      setLiveSrmGeneratedAt(result.generatedAt ?? new Date().toISOString());
      writeBrowserCache("srm-release-status", result);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLiveSrmError(
        error instanceof Error
          ? error.message
          : "Live SRM status is unavailable.",
      );
    } finally {
      if (!signal?.aborted) setLiveSrmLoading(false);
    }
  }

  useEffect(() => {
    if (cachedSrmStatus) {
      setLiveSrmStatuses(cachedServiceStatuses);
      setLiveSrmGeneratedAt(cachedSrmStatus.value.generatedAt ?? "");
      setLiveSrmLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadLiveSrmStatus(false, controller.signal);
    return () => {
      controller.abort();
    };
  }, [service.service.serviceTreeId]);

  function hideServiceGroup(cloud: string, serviceGroupId: string) {
    const key = groupPreferenceKey(cloud, serviceGroupId);
    setHiddenServiceGroups((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setSelectedGroups((current) => ({ ...current, [cloud]: "" }));
  }

  function showServiceGroup(cloud: string, serviceGroupId: string) {
    const key = groupPreferenceKey(cloud, serviceGroupId);
    setHiddenServiceGroups((current) =>
      current.filter((candidate) => candidate !== key),
    );
  }

  function showAllServiceGroups() {
    const servicePrefix = `${service.service.name}:`;
    setHiddenServiceGroups((current) =>
      current.filter((key) => !key.startsWith(servicePrefix)),
    );
  }

  function relationshipRank(
    group: (typeof observations)[number]["serviceGroups"][number],
  ) {
    if (
      group.associations.some(
        (association) => association.serviceName === service.service.name,
      )
    ) {
      return 0;
    }
    return group.associations.length === 0 ? 1 : 2;
  }

  async function getServiceGroups(cloud: string) {
    if (!service.service.serviceTreeId) return;
    setRefreshingCloud(cloud);
    setRefreshError("");
    try {
      const response = await fetch("/__grounds/ev2-service-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceTreeId: service.service.serviceTreeId,
          cloud,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "EV2 service-group discovery failed.");
      }
      setRefreshingCloud(undefined);
    } catch (error) {
      setRefreshError(
        error instanceof Error
          ? error.message
          : "EV2 service-group discovery failed.",
      );
      setRefreshingCloud(undefined);
    }
  }

  return (
    <Section icon="layers" title="EV2 service groups" count={totalGroups}>
      <div className="service-group-operator-buttons">
        <button
          className="operator-portal-button"
          disabled={liveSrmLoading || !service.service.serviceTreeId}
          onClick={() => void loadLiveSrmStatus(true)}
          title="Bypass the local cache and retrieve the latest deployment status from SRM"
          type="button"
        >
          <Icon name="refresh" size={14} />
          {liveSrmLoading ? "Refreshing status..." : "Refresh deployment status"}
        </button>
        <a
          className="operator-portal-button"
          href={srmRootUrl}
          rel="noreferrer"
          target="_blank"
          title="Open the Service Resource Manager portal"
        >
          SRM
          <Icon name="external" size={14} />
        </a>
        {reachablePortalLinks[0] && (
          <a
            className="operator-portal-button"
            href={reachablePortalLinks[0].url}
            rel="noreferrer"
            target="_blank"
            title="Open this service in Public EV2"
          >
            EV2
            <Icon name="external" size={14} />
          </a>
        )}
        {liveSrmGeneratedAt && !liveSrmLoading && (
          <span className="service-group-status-updated">
            Status retrieved{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(liveSrmGeneratedAt))}
          </span>
        )}
      </div>
      <div className="service-group-intro">
        <div>
          <strong>Deployment granulation</strong>
          <p>
            Service groups identify independently deployable units beneath this
            Service Tree. Select a group to focus its infrastructure and deployment
            history.
          </p>
          <a href="#/docs/service-groups">More info about Service Groups</a>
        </div>
        <span className="service-group-intro-note">
          Public EV2 is shown on low-side. USSec and USNat service groups are
          intentionally hidden because those portals require air-gapped access.
        </span>
      </div>
      {refreshError && (
        <div className="service-group-refresh-error" role="alert">
          {refreshError}
        </div>
      )}
      {liveSrmError && (
        <div className="service-group-refresh-error" role="alert">
          SRM deployment status could not be loaded: {liveSrmError}
        </div>
      )}
      <div className="service-group-clouds">
        {reachablePortalLinks.map((portal) => {
          const observation = observations.find(
            (candidate) => candidate.cloud === portal.cloud,
          );
          const discoveredGroups = [...(observation?.serviceGroups ?? [])].sort(
              (left, right) =>
                relationshipRank(left) - relationshipRank(right) ||
                left.displayName.localeCompare(right.displayName),
            );
          const allGroups = discoveredGroups.filter(
            (group) =>
              !hiddenServiceGroupSet.has(
                groupPreferenceKey(portal.cloud, group.serviceGroupId),
              ),
          );
          const associatedGroups = allGroups.filter((group) =>
            group.associations.some(
              (association) => association.serviceName === service.service.name,
            ),
          );
          const hasOperatorSelection = Object.prototype.hasOwnProperty.call(
            selectedGroups,
            portal.cloud,
          );
          const selectedGroupId = hasOperatorSelection
            ? selectedGroups[portal.cloud]
            : associatedGroups.length === 1
              ? associatedGroups[0].serviceGroupId
              : "";
          const serviceGroupQuery =
            serviceGroupQueries[portal.cloud]?.trim().toLocaleLowerCase() ?? "";
          const groups = selectedGroupId
            ? allGroups.filter(
                (group) => group.serviceGroupId === selectedGroupId,
              )
            : serviceGroupQuery
              ? allGroups.filter((group) =>
                  [
                    group.displayName,
                    group.serviceGroupId,
                    describeServiceGroup(group.serviceGroupId),
                    ...group.infrastructures,
                    ...group.associations.map(
                      (association) => association.serviceName,
                    ),
                  ]
                    .join(" ")
                    .toLocaleLowerCase()
                    .includes(serviceGroupQuery),
                )
              : allGroups;
          const showServiceGroupSearch =
            allGroups.length >= serviceGroupSearchThreshold ||
            Boolean(serviceGroupQuery);
          const isRefreshing = refreshingCloud === portal.cloud;
          const showDiscoverySkeleton = isRefreshing && !observation;

          return (
            <article
              aria-busy={isRefreshing}
              className={`service-group-cloud ${showDiscoverySkeleton ? "loading" : ""}`}
              key={portal.cloud}
            >
              <div className="service-group-cloud-header">
                <div>
                  <span>{portal.network}</span>
                  <h3>{portal.label}</h3>
                </div>
                <div>
                  <button
                    className="service-group-refresh"
                    disabled={refreshingCloud !== undefined}
                    onClick={() => getServiceGroups(portal.cloud)}
                    type="button"
                  >
                    <Icon name="refresh" size={13} />
                    {refreshingCloud === portal.cloud
                      ? "Getting groups..."
                      : "Get Service Groups"}
                  </button>
                  <a
                    href={observation?.sourceUrl ?? portal.serviceGroupsUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open in EV2
                    <Icon name="external" size={13} />
                  </a>
                </div>
              </div>

              {showDiscoverySkeleton && (
                <div
                  aria-live="polite"
                  className="service-group-skeleton"
                  role="status"
                >
                  <span className="visually-hidden">
                    Loading EV2 service groups
                  </span>
                  <span className="skeleton-block skeleton-control" />
                  <div className="service-group-skeleton-grid">
                    <span className="skeleton-block skeleton-service-group-card" />
                    <span className="skeleton-block skeleton-service-group-card" />
                    <span className="skeleton-block skeleton-service-group-card" />
                  </div>
                </div>
              )}

              {observation && (
                <div className="service-group-controls">
                  <label>
                    <span>Service group</span>
                    <select
                      onChange={(event) => {
                        setSelectedGroups((current) => ({
                          ...current,
                          [portal.cloud]: event.target.value,
                        }));
                        setServiceGroupQueries((current) => ({
                          ...current,
                          [portal.cloud]: "",
                        }));
                      }}
                      value={selectedGroupId}
                    >
                      <option value="">
                        All service groups ({allGroups.length})
                      </option>
                      {allGroups.map((group) => (
                        <option key={group.serviceGroupId} value={group.serviceGroupId}>
                          {group.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  {showServiceGroupSearch && (
                    <label>
                      <span>Search service groups</span>
                      <div className="service-group-search">
                        <Icon name="search" size={13} />
                        <input
                          aria-label={`Search ${portal.label} service groups`}
                          onChange={(event) => {
                            setServiceGroupQueries((current) => ({
                              ...current,
                              [portal.cloud]: event.target.value,
                            }));
                            setSelectedGroups((current) => ({
                              ...current,
                              [portal.cloud]: "",
                            }));
                          }}
                          placeholder={`Search ${allGroups.length} groups`}
                          type="search"
                          value={serviceGroupQueries[portal.cloud] ?? ""}
                        />
                        {serviceGroupQuery && (
                          <span className="service-group-search-count">
                            {groups.length}
                          </span>
                        )}
                      </div>
                    </label>
                  )}
                  {hiddenGroups.length > 0 && (
                    <details className="hidden-service-groups">
                      <summary>
                        Hidden groups ({hiddenGroups.length})
                      </summary>
                      <div>
                        {hiddenGroups.map(({ cloud, group }) => (
                          <div key={`${cloud}-${group.serviceGroupId}`}>
                            <span>
                              <strong>{group.displayName}</strong>
                              <small>{formatLabel(cloud)}</small>
                            </span>
                            <button
                              onClick={() =>
                                showServiceGroup(cloud, group.serviceGroupId)
                              }
                              type="button"
                            >
                              Show
                            </button>
                          </div>
                        ))}
                        <button
                          className="show-all-service-groups"
                          onClick={showAllServiceGroups}
                          type="button"
                        >
                          Show all
                        </button>
                      </div>
                    </details>
                  )}
                  <span>
                    Observed{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(observation.observedAt))}
                  </span>
                </div>
              )}

              {!observation ? (
                <div className="service-group-empty">
                  No service-group snapshot has been collected for this cloud.
                  Open EV2 to inspect the current groups.
                </div>
              ) : groups.length === 0 ? (
                <div className="service-group-empty">
                  {serviceGroupQuery
                    ? `No service groups match "${serviceGroupQueries[portal.cloud]?.trim()}".`
                    : discoveredGroups.length > 0
                      ? "All discovered service groups are hidden on this service page."
                      : "EV2 returned no service groups for this Service Tree."}
                </div>
              ) : (
                <div className="service-group-list">
                  {groups.map((group) => {
                    const releases = serviceGroupReleases.filter(
                      (release) =>
                        release.serviceGroupId === group.serviceGroupId,
                    );
                    const liveStatusesForGroup = liveSrmStatuses.filter(
                      (status) =>
                        status.serviceGroupName === group.serviceGroupId,
                    );
                    const capturedReleaseIds = new Set(
                      releases.map((release) => release.releaseId),
                    );
                    const observedEnvironments = [
                      ...new Set(
                        [
                          ...releases.flatMap((release) =>
                            release.stages.flatMap((stage) =>
                              stage.cloud ? [stage.cloud] : [],
                            ),
                          ),
                          ...liveStatusesForGroup.map(
                            (status) => status.environment,
                          ),
                        ],
                      ),
                    ];
                    const liveStatuses = liveStatusesForGroup.filter(
                      (status) =>
                        !capturedReleaseIds.has(status.releaseCorrelationId),
                    ).sort((left, right) => {
                      const activeDifference =
                        Number(isActiveSrmStatus(right.status)) -
                        Number(isActiveSrmStatus(left.status));
                      return (
                        activeDifference ||
                        left.environment.localeCompare(right.environment)
                      );
                    });
                    const releaseEntries = releases.map((release) => {
                      const pin = releasePins.find(
                        (candidate) =>
                          candidate.serviceName === release.serviceName &&
                          candidate.serviceGroupId === release.serviceGroupId &&
                          candidate.releaseId === release.releaseId,
                      );
                      return {
                        isActive: liveStatusesForGroup.some(
                          (status) =>
                            status.releaseCorrelationId === release.releaseId &&
                            isActiveSrmStatus(status.status),
                        ),
                        isLive: liveStatusesForGroup.some(
                          (status) =>
                            status.releaseCorrelationId === release.releaseId,
                        ),
                        isPinned: Boolean(pin && !pin.unpinnedAt),
                        release,
                      };
                    });
                    const pinnedReleaseEntries = releaseEntries.filter(
                      (entry) => entry.isPinned,
                    );
                    const previouslyPinnedReleaseEntries = releaseEntries.filter(
                      (entry) => !entry.isPinned,
                    );
                    const renderReleaseEntry = ({
                      isActive,
                      isLive,
                      isPinned,
                      release,
                    }: (typeof releaseEntries)[number]) => (
                      <div
                        className={`pinned-srm-release${isPinned ? "" : " previously-pinned"}${isActive ? " active" : ""}`}
                        key={release.releaseId}
                      >
                        <a
                          href={release.releaseUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <span>
                            <strong>{release.releaseName}</strong>
                            <small>
                              {isLive
                                ? isPinned
                                  ? "Live + pinned"
                                  : "Live + previously pinned"
                                : isPinned
                                  ? "Pinned SRM release"
                                  : "Previously pinned"}{" "}
                              ·{" "}
                              {new Intl.DateTimeFormat("en-US", {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(release.observedAt))}
                            </small>
                            <span className="service-group-stage-statuses">
                              {release.stages.map((stage) => (
                                <span key={stage.name} title={stage.name}>
                                  {stage.cloud
                                    ? formatEnvironmentLabel(stage.cloud)
                                    : stage.name}
                                  : {formatLabel(stage.status)}
                                </span>
                              ))}
                            </span>
                          </span>
                          <span
                            className={`srm-deployment-status ${release.overallStatus}`}
                          >
                            {formatLabel(release.overallStatus)}
                          </span>
                        </a>
                        <button
                          onClick={() =>
                            isPinned
                              ? onUnpinSrmRelease(
                                  release.releaseId,
                                  group.serviceGroupId,
                                )
                              : onPinSrmRelease(
                                  release.releaseId,
                                  group.serviceGroupId,
                                )
                          }
                          type="button"
                        >
                          {isPinned ? "Unpin" : "Pin again"}
                        </button>
                      </div>
                    );

                    return (
                      <div className="service-group-card" key={group.serviceGroupId}>
                        <div className="service-group-heading">
                          <div>
                            <h4>{group.displayName.replaceAll(".", ".\u200B")}</h4>
                            <p className="service-group-description">
                              {describeServiceGroup(group.serviceGroupId)}
                            </p>
                            {observedEnvironments.length > 0 && (
                              <div className="service-group-environments">
                                {observedEnvironments.map((environment) => (
                                  <span
                                    key={environment}
                                    title="Environment observed in pinned SRM deployment data"
                                  >
                                    {formatEnvironmentLabel(environment)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="service-group-card-actions">
                            <button
                              onClick={() =>
                                hideServiceGroup(
                                  portal.cloud,
                                  group.serviceGroupId,
                                )
                              }
                              title={`Hide ${group.displayName} on this service page`}
                              type="button"
                            >
                              Hide
                            </button>
                          </div>
                        </div>
                        <div className="service-group-deployments">
                          <div className="service-group-deployments-header">
                            <span>Observed deployments</span>
                            <button
                              onClick={() =>
                                onOpenSrmRefresh(group.serviceGroupId)
                              }
                              title={`Pin a specific SRM release for ${group.displayName}`}
                              type="button"
                            >
                              <Icon name="refresh" size={12} />
                              Pin SRM release
                            </button>
                          </div>
                          {liveSrmLoading && (
                            <p>Loading current deployment status from SRM...</p>
                          )}
                          {releases.length === 0 &&
                          group.deployments.length === 0 &&
                          liveStatuses.length === 0 &&
                          !liveSrmLoading ? (
                            <p>
                              No live or pinned SRM deployment status was found
                              for this Service Group.
                            </p>
                          ) : (
                            <>
                              {liveStatuses.map((status) => {
                                const content = (
                                  <>
                                    <span>
                                      <strong>
                                        {formatEnvironmentLabel(
                                          status.environment.toLowerCase(),
                                        )}
                                      </strong>
                                      <small>
                                        Live SRM ·{" "}
                                        {new Intl.DateTimeFormat("en-US", {
                                          dateStyle: "medium",
                                          timeStyle: "short",
                                        }).format(new Date(status.updatedAt))}
                                      </small>
                                    </span>
                                    <span className="live-srm-deployment-action">
                                      <span
                                        className={`srm-deployment-status ${status.status.toLowerCase()}`}
                                      >
                                        {status.status}
                                      </span>
                                      {status.releaseUrl && (
                                        <Icon name="external" size={12} />
                                      )}
                                    </span>
                                  </>
                                );
                                return status.releaseUrl ? (
                                  <a
                                    className={`live-srm-deployment${isActiveSrmStatus(status.status) ? " active" : ""}`}
                                    href={status.releaseUrl}
                                    key={`${status.serviceGroupName}-${status.environment}`}
                                    rel="noreferrer"
                                    target="_blank"
                                    title={`Open ${status.releaseName || status.releaseCorrelationId} in SRM`}
                                  >
                                    {content}
                                  </a>
                                ) : (
                                  <div
                                    className={`live-srm-deployment unavailable${isActiveSrmStatus(status.status) ? " active" : ""}`}
                                    key={`${status.serviceGroupName}-${status.environment}`}
                                    title="SRM did not return a release destination for this deployment"
                                  >
                                    {content}
                                  </div>
                                );
                              })}
                              {pinnedReleaseEntries.map(renderReleaseEntry)}
                              {group.deployments.map((deployment) => (
                              <a
                                href={deployment.sourceUrl}
                                key={deployment.deploymentId}
                                rel="noreferrer"
                                target="_blank"
                              >
                                <span>
                                  <strong>{deployment.displayName}</strong>
                                  <small>
                                    {deployment.buildVersion
                                      ? `Build ${deployment.buildVersion}`
                                      : deployment.deploymentId}
                                  </small>
                                </span>
                                <span className={`srm-deployment-status ${deployment.status}`}>
                                  {formatLabel(deployment.status)}
                                </span>
                              </a>
                              ))}
                              {previouslyPinnedReleaseEntries.length > 0 && (
                              <details className="previously-pinned-releases">
                                <summary>
                                  Previously pinned (
                                  {previouslyPinnedReleaseEntries.length})
                                </summary>
                                <div>
                                  {previouslyPinnedReleaseEntries.map(
                                    renderReleaseEntry,
                                  )}
                                </div>
                              </details>
                              )}
                            </>
                          )}
                        </div>
                        <a
                          className="service-group-source"
                          href={group.sourceUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          View service group
                          <Icon name="external" size={13} />
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </Section>
  );
}

function ServiceDetail({
  service,
  onBack,
  onNavigate,
  onTroubleshoot,
}: {
  service: CatalogService;
  onBack: () => void;
  onNavigate: (service: CatalogService) => void;
  onTroubleshoot: () => void;
}) {
  const pipelines = [
    ...service.pipelines.build.map((pipeline) => ({ pipeline, stage: "Build" as const })),
    ...service.pipelines.release.map((pipeline) => ({ pipeline, stage: "Release" as const })),
  ];
  const links = [
    ...service.documentation,
    ...(service.dashboards ?? []),
  ];
  const ev2PortalLinks = getEv2PortalLinks(service);
  const srmServiceGroupOptions = getSrmServiceGroupOptions(service);
  const teamsSignals = teamsIntelligence.signals.filter((signal) => {
    const scopeMatches =
      signal.scope.type === "catalog" ||
      signal.scope.serviceNames.includes(service.service.name);
    const cloudMatches =
      !signal.clouds ||
      signal.clouds.some((cloud) =>
        service.environments?.some(
          (environment) => environment.cloud === cloud,
        ),
      );

    return scopeMatches && cloudMatches;
  });
  const [serviceTreeCopied, setServiceTreeCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [isJsonOpen, setIsJsonOpen] = useState(false);
  const [isWorkOpen, setIsWorkOpen] = useState(false);
  const [isSrmRefreshOpen, setIsSrmRefreshOpen] = useState(false);
  const [srmReleaseUrl, setSrmReleaseUrl] = useState("");
  const [srmServiceGroupId, setSrmServiceGroupId] = useState("");
  const [srmReleasePins, setSrmReleasePins] =
    useState<SrmReleasePin[]>(loadSrmReleasePins);
  const [srmRefreshState, setSrmRefreshState] = useState<
    "idle" | "refreshing" | "error"
  >("idle");
  const [srmRefreshError, setSrmRefreshError] = useState("");
  const selectedSrmServiceGroup = srmServiceGroupOptions.find(
    (group) => group.serviceGroupId === srmServiceGroupId,
  );
  const [validation, setValidation] = useState<ServiceValidation | undefined>(
    () => serviceValidationByPath.get(service.sourcePath),
  );
  const {
    domain: _domain,
    sourceFilePath: _sourceFilePath,
    sourcePath: _sourcePath,
    ...serviceRecord
  } = service;
  const serviceJson = JSON.stringify(serviceRecord, null, 2);

  useEffect(() => {
    setValidation(serviceValidationByPath.get(service.sourcePath));
  }, [service.sourcePath]);

  useEffect(() => {
    window.localStorage.setItem(
      srmReleasePinsStorageKey,
      JSON.stringify(srmReleasePins),
    );
  }, [srmReleasePins]);

  useEffect(() => {
    if (!import.meta.hot) return;

    function handleValidation(nextValidation: ServiceValidation) {
      if (nextValidation.sourcePath === service.sourcePath) {
        setValidation(nextValidation);
      }
    }

    import.meta.hot.on("grounds:service-validation", handleValidation);
    return () => {
      import.meta.hot?.off("grounds:service-validation", handleValidation);
    };
  }, [service.sourcePath]);

  useEffect(() => {
    if (!isJsonOpen && !isSrmRefreshOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsJsonOpen(false);
        if (srmRefreshState !== "refreshing") setIsSrmRefreshOpen(false);
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isJsonOpen, isSrmRefreshOpen, srmRefreshState]);

  async function copyServiceTreeId() {
    if (!service.service.serviceTreeId) return;
    await navigator.clipboard.writeText(service.service.serviceTreeId);
    setServiceTreeCopied(true);
    window.setTimeout(() => setServiceTreeCopied(false), 1500);
  }

  async function copyServiceJson() {
    await navigator.clipboard.writeText(serviceJson);
    setJsonCopied(true);
    window.setTimeout(() => setJsonCopied(false), 1500);
  }

  function openSrmRefresh(serviceGroupId: string) {
    setSrmRefreshError("");
    setSrmRefreshState("idle");
    setSrmReleaseUrl("");
    setSrmServiceGroupId(serviceGroupId);
    setIsSrmRefreshOpen(true);
  }

  function pinSrmRelease(releaseId: string, serviceGroupId: string) {
    const pinnedAt = new Date().toISOString();
    setSrmReleasePins((current) => [
      ...current.filter(
        (pin) =>
          !(
            pin.serviceName === service.service.name &&
            pin.serviceGroupId === serviceGroupId &&
            pin.releaseId === releaseId
          ),
      ),
      {
        pinnedAt,
        releaseId,
        serviceGroupId,
        serviceName: service.service.name,
      },
    ]);
  }

  function unpinSrmRelease(releaseId: string, serviceGroupId: string) {
    const unpinnedAt = new Date().toISOString();
    setSrmReleasePins((current) =>
      current.map((pin) =>
        pin.serviceName === service.service.name &&
        pin.serviceGroupId === serviceGroupId &&
        pin.releaseId === releaseId
          ? { ...pin, unpinnedAt }
          : pin,
      ),
    );
  }

  async function refreshFromSrm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!service.service.serviceTreeId || !srmServiceGroupId) return;

    setSrmRefreshState("refreshing");
    setSrmRefreshError("");
    try {
      const response = await fetch("/__grounds/srm-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceName: service.service.name,
          serviceTreeId: service.service.serviceTreeId,
          serviceGroupId: srmServiceGroupId,
          releaseUrl: srmReleaseUrl.trim(),
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "SRM refresh failed.");
      }
      const releaseId = new URL(srmReleaseUrl.trim()).hash.split("/").at(-1);
      if (releaseId) pinSrmRelease(releaseId, srmServiceGroupId);
      setIsSrmRefreshOpen(false);
      setSrmRefreshState("idle");
      setSrmReleaseUrl("");
      setSrmServiceGroupId("");
    } catch (error) {
      setSrmRefreshState("error");
      setSrmRefreshError(
        error instanceof Error ? error.message : "SRM refresh failed.",
      );
    }
  }

  return (
    <>
      <main className="content detail-content">
      <div className="detail-actions">
        <button className="back-button" onClick={onBack}>
          <Icon name="chevron" size={16} />
          Back to catalog
        </button>
        <div className="detail-action-group">
          <button className="json-view-button troubleshoot-button" onClick={onTroubleshoot}>
            <Icon name="sparkles" size={16} />
            Troubleshoot
          </button>
          <button className="json-view-button" onClick={() => setIsWorkOpen(true)}>
            <Icon name="edit" size={16} />
            Work
          </button>
          <button className="json-view-button" onClick={() => setIsJsonOpen(true)}>
            <Icon name="code" size={16} />
            JSON View
          </button>
        </div>
      </div>
      <section className="detail-hero">
        <div className="detail-title-row">
          <span className={`service-glyph large ${service.domain}`}>
            <Icon name="service" size={26} />
          </span>
          <div>
            <span className="eyebrow">{domainLabels[service.domain]}</span>
            <h1>{service.service.displayName}</h1>
          </div>
        </div>
        <p>{service.service.description}</p>
        <div className="detail-badges">
          <OperationalImpactTierButton
            detail
            service={service}
          />
          <span>{formatLabel(service.service.lifecycle)}</span>
          <span>{formatLabel(service.service.serviceType)}</span>
          {service.service.serviceTreeId && (
            <button
              className="service-tree-id"
              onClick={copyServiceTreeId}
              title="Copy Service Tree ID"
            >
              <span>Service Tree</span>
              <code>{service.service.serviceTreeId}</code>
              <Icon name={serviceTreeCopied ? "check" : "copy"} size={13} />
            </button>
          )}
        </div>
      </section>

      <section className="quick-facts">
        <div><span>Branch</span><strong>{service.currentVersion.branch ?? "Unknown"}</strong></div>
        <div><span>Repositories</span><strong>{service.repositories.length}</strong></div>
        <div><span>Dependencies</span><strong>{service.dependencies?.length ?? 0}</strong></div>
        <div><span>Known issues</span><strong>{service.knownIssues.length}</strong></div>
      </section>

      {service.service.resourceTypes && service.service.resourceTypes.length > 0 && (
        <Section icon="layers" title="ARM resource types" count={service.service.resourceTypes.length}>
          <div className="code-list">
            {service.service.resourceTypes.map((resourceType) => (
              <code key={resourceType}>{resourceType}</code>
            ))}
          </div>
        </Section>
      )}

      <Section icon="code" title="Repositories" count={service.repositories.length}>
        <div className="two-column-grid">
          {service.repositories.map((repository) => (
            <RepositoryCard key={`${repository.name}-${repository.purpose}`} repository={repository} />
          ))}
        </div>
      </Section>

      <Section icon="pipeline" title="Build and release" count={pipelines.length}>
        <div className="two-column-grid">
          {pipelines.map(({ pipeline, stage }) => (
            <PipelineCard key={`${stage}-${pipeline.name}`} pipeline={pipeline} stage={stage} />
          ))}
        </div>
      </Section>

      {service.service.serviceTreeId && ev2PortalLinks.length > 0 && (
        <ServiceGroupsSection
          onPinSrmRelease={pinSrmRelease}
          onOpenSrmRefresh={openSrmRefresh}
          onUnpinSrmRelease={unpinSrmRelease}
          portalLinks={ev2PortalLinks}
          releasePins={srmReleasePins}
          service={service}
        />
      )}

      {service.operationalChannels && service.operationalChannels.length > 0 && (
        <Section
          icon="service"
          title="Operational channels"
          count={service.operationalChannels.length}
        >
          <div className="link-grid">
            {service.operationalChannels.map((channel) => (
              <OperationalChannelCard
                channel={channel}
                key={`${channel.platform}-${channel.name}`}
              />
            ))}
          </div>
        </Section>
      )}

      {teamsSignals.length > 0 && (
        <Section
          icon="warning"
          title="Teams deployment intelligence"
          count={teamsSignals.length}
        >
          <div className="teams-verification-banner" role="note">
            <Icon name="warning" size={18} />
            <div>
              <strong>Independent verification required</strong>
              <p>
                Teams information may be incomplete or stale. Verify authoritative
                deployment status in EV2, Azure DevOps, IcM, or service telemetry
                before acting.
              </p>
            </div>
          </div>
          <div className="teams-signal-list">
            {teamsSignals.map((signal) => (
              <article className="teams-signal-card" key={signal.id}>
                <div className="teams-signal-heading">
                  <div>
                    <span className="minor-label">
                      {formatLabel(signal.kind)}
                    </span>
                    <h3>{signal.title}</h3>
                  </div>
                  <span className="unverified-badge">
                    {formatLabel(signal.verificationStatus)}
                  </span>
                </div>
                <p>{signal.summary}</p>
                <div className="teams-signal-meta">
                  <div>
                    {signal.clouds?.map((cloud) => (
                      <span key={cloud}>{formatLabel(cloud)}</span>
                    ))}
                    <time dateTime={signal.observedAt}>
                      Reported{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(signal.observedAt))}
                    </time>
                  </div>
                  <ExternalLink href={signal.sourceUrl}>
                    View source message · {signal.sourceName}
                  </ExternalLink>
                </div>
              </article>
            ))}
          </div>
          <p className="teams-snapshot-window">
            Snapshot window:{" "}
            {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
              new Date(teamsIntelligence.windowStart),
            )}{" "}
            through{" "}
            {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
              new Date(teamsIntelligence.windowEnd),
            )}
          </p>
        </Section>
      )}

      {service.dependencies && service.dependencies.length > 0 && (
        <Section icon="branch" title="Dependencies" count={service.dependencies.length}>
          <div className="dependency-list">
            {service.dependencies.map((dependency) => (
              <DependencyCard
                dependency={dependency}
                key={`${dependency.direction}-${dependency.service}`}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </Section>
      )}

      {links.length > 0 && (
        <Section icon="docs" title="Operational resources" count={links.length}>
          <div className="link-grid">
            {links.map((link) => (
              <LinkCard key={`${link.type}-${link.title}`} link={link} />
            ))}
          </div>
        </Section>
      )}

      {service.knownIssues.length > 0 && (
        <Section icon="warning" title="Known issues" count={service.knownIssues.length}>
          <div className="issue-list">
            {service.knownIssues.map((issue) => (
              <article className="issue-card" key={issue.id}>
                <span className={`issue-severity ${issue.severity}`}>{issue.severity}</span>
                <div>
                  <span className="minor-label">{issue.id} / {formatLabel(issue.status)}</span>
                  <h3>{issue.title}</h3>
                  <p>{issue.summary}</p>
                  {issue.mitigation && <small>Mitigation: {issue.mitigation}</small>}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}

      <footer className="record-footer">
        <span>Source: {service.sourcePath}</span>
        <span>
          Last updated{" "}
          {service.lastUpdated
            ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
                new Date(service.lastUpdated),
              )
            : "unknown"}
        </span>
      </footer>
      </main>

      <div
        className={`json-drawer-layer ${isJsonOpen ? "open" : ""}`}
        aria-hidden={!isJsonOpen}
      >
        <button
          aria-label="Close JSON view"
          className="json-drawer-backdrop"
          onClick={() => setIsJsonOpen(false)}
          tabIndex={isJsonOpen ? 0 : -1}
        />
        <aside
          aria-label={`${service.service.displayName} JSON`}
          aria-modal="true"
          className="json-drawer"
          role="dialog"
        >
          <div className="json-drawer-header">
            <div>
              <span className="eyebrow">Service record</span>
              <h2>JSON View</h2>
              <p>{service.sourcePath}</p>
            </div>
            <button
              aria-label="Close JSON view"
              className="json-drawer-close"
              onClick={() => setIsJsonOpen(false)}
            >
              <Icon name="close" size={19} />
            </button>
          </div>
          <div className="json-drawer-toolbar">
            <span
              className={`json-validation-status ${validation?.status ?? "checking"}`}
              role="status"
            >
              <span />
              {validation?.status === "valid"
                ? "Schema valid"
                : validation?.status === "invalid"
                  ? "Schema invalid"
                  : "Checking schema"}
            </span>
            <div className="json-drawer-actions">
              <a
                href={vscodeFileUri(service.sourceFilePath)}
                title={`Edit ${service.sourcePath} in a new Visual Studio Code window`}
              >
                <Icon name="code" size={15} />
                VS Code
              </a>
              <button onClick={copyServiceJson}>
                <Icon name={jsonCopied ? "check" : "copy"} size={15} />
                {jsonCopied ? "Copied" : "Copy JSON"}
              </button>
            </div>
          </div>
          {validation?.status === "invalid" && (
            <div className="json-validation-errors" role="alert">
              <strong>
                The file on disk is invalid. Grounds is showing the last valid record.
              </strong>
              <ul>
                {validation.errors.map((error, index) => (
                  <li key={`${error.instancePath}-${error.keyword}-${index}`}>
                    <code>{error.instancePath}</code> {error.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <pre className="json-code"><code>{serviceJson}</code></pre>
        </aside>
      </div>

      <WorkDrawer
        onClose={() => setIsWorkOpen(false)}
        open={isWorkOpen}
        service={service}
        serviceGroups={srmServiceGroupOptions}
      />

      {isSrmRefreshOpen && (
        <div className="srm-refresh-layer">
          <button
            aria-label="Close SRM refresh"
            className="srm-refresh-backdrop"
            disabled={srmRefreshState === "refreshing"}
            onClick={() => setIsSrmRefreshOpen(false)}
          />
          <section
            aria-labelledby="srm-refresh-title"
            aria-modal="true"
            className="srm-refresh-dialog"
            role="dialog"
          >
            <div className="srm-refresh-header">
              <div>
                <span className="eyebrow">Authoritative deployment observation</span>
                <h2 id="srm-refresh-title">Pin specific SRM release</h2>
              </div>
              <button
                aria-label="Close SRM refresh"
                disabled={srmRefreshState === "refreshing"}
                onClick={() => setIsSrmRefreshOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            <p>
              Paste an SRM release URL for {service.service.displayName}. Grounds
              will open its dedicated Edge profile, capture the detailed release
              evidence, and pin it to the selected EV2 service group.
            </p>
            <form onSubmit={refreshFromSrm}>
              <label htmlFor="srm-release-url">SRM release URL</label>
              <input
                autoFocus
                disabled={srmRefreshState === "refreshing"}
                id="srm-release-url"
                onChange={(event) => setSrmReleaseUrl(event.target.value)}
                placeholder="https://srm.azure.com/#/ReleaseStatus/Release/..."
                required
                type="url"
                value={srmReleaseUrl}
              />
              <label htmlFor="srm-service-group">EV2 service group</label>
              <div className="srm-selected-service-group" id="srm-service-group">
                <strong>
                  {selectedSrmServiceGroup?.displayName ?? srmServiceGroupId}
                </strong>
                <code>{srmServiceGroupId}</code>
              </div>
              {srmRefreshState === "refreshing" && (
                <div className="srm-refresh-progress" role="status">
                  <span />
                  Waiting for Edge sign-in and reading the release...
                </div>
              )}
              {srmRefreshError && (
                <div className="srm-refresh-error" role="alert">
                  {srmRefreshError}
                </div>
              )}
              <div className="srm-refresh-actions">
                <button
                  disabled={srmRefreshState === "refreshing"}
                  onClick={() => setIsSrmRefreshOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  disabled={
                    srmRefreshState === "refreshing" ||
                    !srmServiceGroupId
                  }
                  type="submit"
                >
                  {srmRefreshState === "refreshing" ? "Pinning..." : "Open Edge and pin"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

export function App() {
  const [query, setQuery] = useState("");
  const [textSize, setTextSize] = useState<TextSize>(initialTextSize);
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [highContrast, setHighContrast] = useState(initialHighContrast);
  const [isNarrow, setIsNarrow] = useState(() =>
    window.matchMedia("(max-width: 820px)").matches
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => window.localStorage.getItem("grounds-sidebar-collapsed") === "true",
  );
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<AppPage>(initialPage);
  const [activeDomain, setActiveDomain] = useState<ServiceDomain | "all">("all");
  const [selectedName, setSelectedName] = useState<string | undefined>(
    initialServiceName,
  );
  const [serviceView, setServiceView] = useState(initialServiceView);
  const [deploymentDomain, setDeploymentDomain] = useState<ServiceDomain>(
    initialDeploymentDomain,
  );
  const selectedService = services.find(
    (service) => service.service.name === selectedName,
  );

  useEffect(() => {
    function followHashNavigation() {
      const page = initialPage();
      const serviceName = initialServiceName();
      setActivePage(page);
      if (page === "domain-deployments") {
        setDeploymentDomain(initialDeploymentDomain());
      }
      setSelectedName(page === "catalog" ? serviceName : undefined);
      setServiceView(initialServiceView());
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    window.addEventListener("hashchange", followHashNavigation);
    return () => window.removeEventListener("hashchange", followHashNavigation);
  }, []);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (
        event.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".global-search input")?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = textSizeRootValues[textSize];
    window.localStorage.setItem("grounds-text-size", String(textSize));
  }, [textSize]);

  useEffect(() => {
    document.documentElement.dataset.theme = colorMode;
    window.localStorage.setItem("grounds-color-mode", colorMode);
  }, [colorMode]);

  useEffect(() => {
    document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
    window.localStorage.setItem(
      "grounds-high-contrast",
      String(highContrast),
    );
  }, [highContrast]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    function updateLayout(event: MediaQueryListEvent) {
      setIsNarrow(event.matches);
      if (!event.matches) setIsMobileSidebarOpen(false);
    }
    mediaQuery.addEventListener("change", updateLayout);
    return () => mediaQuery.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "grounds-sidebar-collapsed",
      String(isSidebarCollapsed),
    );
  }, [isSidebarCollapsed]);

  function closeMobileSidebar() {
    if (isNarrow) setIsMobileSidebarOpen(false);
  }

  function selectService(service: CatalogService) {
    closeMobileSidebar();
    setActivePage("catalog");
    setSelectedName(service.service.name);
    setServiceView("overview");
    window.history.replaceState(null, "", `#/service/${service.service.name}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showOverview() {
    closeMobileSidebar();
    setActivePage("catalog");
    setSelectedName(undefined);
    setServiceView("overview");
    window.history.replaceState(null, "", window.location.pathname);
  }

  function showServiceDeployments() {
    if (!selectedService) return;
    setServiceView("deployments");
    window.history.replaceState(
      null,
      "",
      `#/service/${selectedService.service.name}/deployments`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showServiceTroubleshoot() {
    if (!selectedService) return;
    setServiceView("troubleshoot");
    window.history.replaceState(
      null,
      "",
      `#/service/${selectedService.service.name}/troubleshoot`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDomainDeployments(domain: ServiceDomain) {
    closeMobileSidebar();
    setDeploymentDomain(domain);
    setActiveDomain(domain);
    setActivePage("domain-deployments");
    setSelectedName(undefined);
    window.history.replaceState(
      null,
      "",
      `#/domain/${domain}/deployments`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDeploymentDomainCatalog() {
    setActivePage("catalog");
    setActiveDomain(deploymentDomain);
    setSelectedName(undefined);
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showServiceOverview() {
    if (!selectedService) return;
    setServiceView("overview");
    window.history.replaceState(
      null,
      "",
      `#/service/${selectedService.service.name}`,
    );
  }

  function showAbout() {
    closeMobileSidebar();
    setActivePage("about");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/about");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showNotes() {
    closeMobileSidebar();
    setActivePage("notes");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/notes");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showGitHistory() {
    closeMobileSidebar();
    setActivePage("git-history");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/git-history");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showLocalRepos() {
    closeMobileSidebar();
    setActivePage("local-repos");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/local-repos");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDailyReport() {
    closeMobileSidebar();
    setActivePage("daily-report");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/daily-report");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showFlows() {
    closeMobileSidebar();
    setActivePage("flows");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/flows");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showWorkItems() {
    closeMobileSidebar();
    setActivePage("work-items");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/work-items");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDeploymentDiffs() {
    closeMobileSidebar();
    setActivePage("deployment-diffs");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/deployment-diffs");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showDocs() {
    closeMobileSidebar();
    setActivePage("docs");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/docs");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showAccessibility() {
    closeMobileSidebar();
    setActivePage("accessibility");
    setSelectedName(undefined);
    window.history.replaceState(null, "", "#/accessibility");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div
      className={`app-shell ${
        isSidebarCollapsed ? "sidebar-collapsed" : ""
      } ${isMobileSidebarOpen ? "mobile-sidebar-open" : ""}`}
    >
      <AppHeader
        isNavigationOpen={isMobileSidebarOpen}
        isNarrow={isNarrow}
        onNavigationOpen={() => setIsMobileSidebarOpen(true)}
        onHome={showOverview}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery);
          if (selectedService || activePage !== "catalog") showOverview();
        }}
        query={query}
      />
      <Sidebar
        activePage={activePage}
        activeDomain={activeDomain}
        isCollapsed={isSidebarCollapsed}
        isNarrow={isNarrow}
        onAccessibility={showAccessibility}
        onAbout={showAbout}
        onCollapseToggle={() => {
          if (isNarrow) {
            setIsMobileSidebarOpen(false);
          } else {
            setIsSidebarCollapsed((isCollapsed) => !isCollapsed);
          }
        }}
        onDocs={showDocs}
        onDeploymentDiffs={showDeploymentDiffs}
        onDomainChange={setActiveDomain}
        onGitHistory={showGitHistory}
        onLocalRepos={showLocalRepos}
        onDailyReport={showDailyReport}
        onFlows={showFlows}
        onWorkItems={showWorkItems}
        onNotes={showNotes}
        onOverview={showOverview}
      />
      {isMobileSidebarOpen && (
        <button
          aria-label="Close navigation"
          className="sidebar-scrim"
          onClick={() => setIsMobileSidebarOpen(false)}
          type="button"
        />
      )}
      <div className="main-view">
        {activePage === "notes" ? (
          <NotesPage />
        ) : activePage === "work-items" ? (
          <WorkItemsPage />
        ) : activePage === "git-history" ? (
          <GitHistoryPage />
        ) : activePage === "local-repos" ? (
          <LocalReposPage />
        ) : activePage === "daily-report" ? (
          <DailyReportPage />
        ) : activePage === "flows" ? (
          <FlowsPage onNavigate={selectService} />
        ) : activePage === "deployment-diffs" ? (
          <DeploymentDiffsPage />
        ) : activePage === "domain-deployments" ? (
          <DomainDeploymentsPage
            domain={deploymentDomain}
            onBack={showDeploymentDomainCatalog}
            onNavigate={selectService}
          />
        ) : activePage === "docs" ? (
          <Docs />
        ) : activePage === "about" ? (
          <About />
        ) : activePage === "accessibility" ? (
          <Accessibility
            colorMode={colorMode}
            highContrast={highContrast}
            onColorModeChange={setColorMode}
            onHighContrastChange={setHighContrast}
            onTextSizeChange={setTextSize}
            textSize={textSize}
          />
        ) : selectedService && serviceView === "deployments" ? (
          <DeploymentsPage
            onBack={showServiceOverview}
            service={selectedService}
          />
        ) : selectedService && serviceView === "troubleshoot" ? (
          <ServiceChatPage
            onBack={showServiceOverview}
            service={selectedService}
          />
        ) : selectedService ? (
          <ServiceDetail
            onBack={showOverview}
            onNavigate={selectService}
            onTroubleshoot={showServiceTroubleshoot}
            service={selectedService}
          />
        ) : (
          <Overview
            activeDomain={activeDomain}
            onDeployments={showDomainDeployments}
            onSelect={selectService}
            query={query}
          />
        )}
      </div>
    </div>
  );
}
