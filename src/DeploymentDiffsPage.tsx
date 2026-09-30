import { useEffect, useMemo, useState } from "react";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

type TargetCloud = "ussec" | "usnat" | "fairfax";
type ComparisonRisk = "high" | "medium" | "low";
type ServiceGroupView = "following" | "all";

const followedServiceGroupsStorageKey =
  "grounds-followed-deployment-service-groups";
const deploymentSnapshotStorageKey = "grounds-deployment-status-snapshot";

interface BuildReference {
  branch: string;
  buildId: number;
  buildNumber: string;
  finishTime: string;
  sourceVersion: string;
  sourceVersionUrl: string;
  url: string;
}

interface ChangedFile {
  categories: string[];
  changeType: string;
  environments: TargetCloud[];
  isDeployment: boolean;
  isServiceScoped: boolean;
  path: string;
}

interface ComparedCommit {
  author: string;
  comment: string;
  commitId: string;
  date: string;
  url: string;
}

interface RelatedPullRequest {
  pullRequestId: number;
  title: string;
  url: string;
}

interface SrmContext {
  overallStatus: string;
  releaseName: string;
  releaseUrl: string;
  serviceGroupId?: string;
  stages: Array<{
    cloud: TargetCloud;
    name: string;
    status: string;
    updatedOn?: string;
  }>;
  updatedOn?: string;
}

interface ServiceGroupTarget {
  associationBasis: string;
  associationEvidence?: string;
  clouds: string[];
  displayName: string;
  infrastructures: string[];
  serviceGroupId: string;
  sourceUrl: string;
}

interface LiveServiceGroupDeployment {
  deploymentCorrelationId: string;
  environment: string;
  releaseCorrelationId: string;
  serviceGroupName: string;
  serviceTreeId: string;
  status: string;
  updatedAt: string;
}

interface SrmReleaseBuild {
  buildNumber: string;
  environment: string;
  repository: string;
  status: string;
}

interface SrmRelease {
  builds: SrmReleaseBuild[];
  releaseCorrelationId: string;
  releaseName: string;
  status: string;
}

interface SrmStatusResponse {
  deploymentHistory: LiveServiceGroupDeployment[];
  generatedAt: string;
  releases: SrmRelease[];
  serviceGroups: LiveServiceGroupDeployment[];
}

interface DeploymentComparison {
  aheadCount?: number;
  changeCount?: number;
  changeCategoryCounts?: Record<string, number>;
  changes?: ChangedFile[];
  commits?: ComparedCommit[];
  compareUrl?: string;
  current?: BuildReference;
  definitionId?: number;
  definitionName?: string;
  deploymentLineageConfirmed?: boolean;
  deploymentPathChangeCount?: number;
  environments: string[];
  environmentChangeCounts?: Record<TargetCloud, number>;
  error?: string;
  evidence: "build" | "unavailable";
  impactReasons?: string[];
  operationalImpactTier?: "critical" | "high" | "medium" | "low";
  pipelineName: string;
  previous?: BuildReference;
  pullRequests?: RelatedPullRequest[];
  repository?: string;
  risk?: ComparisonRisk;
  serviceDisplayName: string;
  serviceGroups: ServiceGroupTarget[];
  serviceName: string;
  serviceTreeId?: string;
  serviceScopedChangeCount?: number;
  srmContext?: SrmContext[];
  status: "available" | "insufficient-builds" | "unavailable";
}

interface DeploymentUpdate {
  currentStatus: string;
  environment: string;
  previousStatus: string;
  serviceGroupName: string;
  serviceTreeId: string;
}

interface DeploymentSnapshotValue {
  releaseCorrelationId: string;
  status: string;
  updatedAt: string;
}

interface DeploymentDiffsResponse {
  comparisons: DeploymentComparison[];
  generatedAt: string;
  targetClouds: TargetCloud[];
}

async function readApi<T>(response: Response) {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Grounds deployment diff request failed.");
  }
  return result;
}

function cloudLabel(cloud: TargetCloud) {
  if (cloud === "ussec") return "USSec";
  if (cloud === "usnat") return "USNat";
  return "Fairfax";
}

function environmentLabel(environment: string) {
  const normalized = environment.toLocaleLowerCase();
  if (normalized === "ussec" || normalized === "usnat" || normalized === "fairfax") {
    return cloudLabel(normalized);
  }
  return environment || "Unknown environment";
}

function formatDate(value?: string) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function readFollowedServiceGroups() {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(followedServiceGroupsStorageKey) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function serviceGroupFollowKey(
  comparison: DeploymentComparison,
  serviceGroupId: string,
) {
  return `${comparison.serviceName}:${serviceGroupId}`;
}

function statusClass(status: string) {
  const normalized = status.toLocaleLowerCase();
  if (normalized.includes("fail")) return "failed";
  if (normalized.includes("complete") || normalized.includes("success")) {
    return "completed";
  }
  if (
    normalized.includes("process") ||
    normalized.includes("progress") ||
    normalized.includes("pending")
  ) {
    return "in-progress";
  }
  return "unknown";
}

function categoryLabel(category: string) {
  const labels: Record<string, string> = {
    code: "Service code",
    deployment: "EV2 / rollout",
    documentation: "Documentation",
    identity: "Identity / certificates",
    network: "Network",
    other: "Other",
    sovereign: "Sovereign configuration",
    tests: "Tests",
  };
  return labels[category] ?? category;
}

function deploymentSnapshotKey(deployment: LiveServiceGroupDeployment) {
  return [
    deployment.serviceTreeId.toLocaleLowerCase(),
    deployment.serviceGroupName,
    deployment.environment.toLocaleLowerCase(),
  ].join(":");
}

function readDeploymentSnapshot() {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(deploymentSnapshotStorageKey) ?? "{}",
    );
    return value && typeof value === "object"
      ? (value as Record<string, DeploymentSnapshotValue>)
      : {};
  } catch {
    return {};
  }
}

function captureDeploymentUpdates(deployments: LiveServiceGroupDeployment[]) {
  const previous = readDeploymentSnapshot();
  const current: Record<string, DeploymentSnapshotValue> = {};
  const updates: DeploymentUpdate[] = [];
  const hasBaseline = Object.keys(previous).length > 0;

  for (const deployment of deployments) {
    const key = deploymentSnapshotKey(deployment);
    current[key] = {
      releaseCorrelationId: deployment.releaseCorrelationId,
      status: deployment.status,
      updatedAt: deployment.updatedAt,
    };
    const prior = previous[key];
    if (
      hasBaseline &&
      prior &&
      (prior.releaseCorrelationId !== deployment.releaseCorrelationId ||
        prior.status !== deployment.status ||
        prior.updatedAt !== deployment.updatedAt)
    ) {
      updates.push({
        currentStatus: deployment.status,
        environment: deployment.environment,
        previousStatus: prior.status,
        serviceGroupName: deployment.serviceGroupName,
        serviceTreeId: deployment.serviceTreeId,
      });
    }
  }

  window.localStorage.setItem(
    deploymentSnapshotStorageKey,
    JSON.stringify(current),
  );
  return updates;
}

function deploymentUpdateKey(update: DeploymentUpdate) {
  return [
    update.serviceTreeId.toLocaleLowerCase(),
    update.serviceGroupName,
    update.environment.toLocaleLowerCase(),
  ].join(":");
}

function mergeDeploymentUpdates(
  current: DeploymentUpdate[],
  detected: DeploymentUpdate[],
) {
  const updates = new Map(
    current.map((update) => [deploymentUpdateKey(update), update]),
  );
  for (const update of detected) {
    updates.set(deploymentUpdateKey(update), update);
  }
  return [...updates.values()];
}

function releaseForDeployment(
  deployment: LiveServiceGroupDeployment,
  srmStatus?: SrmStatusResponse,
) {
  return srmStatus?.releases.find(
    (release) =>
      release.releaseCorrelationId === deployment.releaseCorrelationId,
  );
}

function buildLineage(
  deployment: LiveServiceGroupDeployment,
  comparison: DeploymentComparison,
  srmStatus?: SrmStatusResponse,
) {
  const release = releaseForDeployment(deployment, srmStatus);
  const buildNumbers = new Set(
    (release?.builds ?? []).map((build) => String(build.buildNumber)),
  );
  if (
    comparison.current &&
    buildNumbers.has(String(comparison.current.buildNumber))
  ) {
    return { className: "current", label: "Current build", release };
  }
  if (
    comparison.previous &&
    buildNumbers.has(String(comparison.previous.buildNumber))
  ) {
    return { className: "previous", label: "Previous build", release };
  }
  return {
    className: "unmatched",
    label: release ? "Different build" : "Build not resolved",
    release,
  };
}

function paritySummary(
  deployments: LiveServiceGroupDeployment[],
  comparison: DeploymentComparison,
  srmStatus?: SrmStatusResponse,
) {
  if (deployments.length === 0) return "No environment deployment data";
  const lineages = deployments.map(
    (deployment) => buildLineage(deployment, comparison, srmStatus).className,
  );
  if (lineages.every((lineage) => lineage === "current")) {
    return `Current build in ${deployments.length} environment${deployments.length === 1 ? "" : "s"}`;
  }
  if (lineages.includes("current") && lineages.includes("previous")) {
    return "Environment drift: current and previous builds";
  }
  const releases = new Set(
    deployments
      .map((deployment) => deployment.releaseCorrelationId)
      .filter(Boolean),
  );
  if (releases.size === 1 && deployments.length > 1) {
    return `Same SRM release in ${deployments.length} environments`;
  }
  if (releases.size > 1) return "Environment releases differ";
  return "Build lineage is not resolved";
}

function buildSummary(build: BuildReference) {
  return (
    <div className="deployment-build-reference">
      <a href={build.url} rel="noreferrer" target="_blank">
        {build.buildNumber}
      </a>
      <code>{build.sourceVersion.slice(0, 12)}</code>
      <span>{build.branch || "unknown branch"}</span>
      <time dateTime={build.finishTime}>{formatDate(build.finishTime)}</time>
    </div>
  );
}

function focusChangeCount(comparison: DeploymentComparison) {
  return Object.values(comparison.environmentChangeCounts ?? {}).reduce(
    (total, count) => total + count,
    0,
  );
}

function serviceGroupEntries(
  comparison: DeploymentComparison,
  srmStatus?: SrmStatusResponse,
) {
  const verifiedTargets = new Map(
    comparison.serviceGroups.map((group) => [group.serviceGroupId, group]),
  );
  const deployments = (srmStatus?.serviceGroups ?? []).filter(
    (deployment) =>
      comparison.serviceTreeId &&
      deployment.serviceTreeId.toLocaleLowerCase() ===
        comparison.serviceTreeId.toLocaleLowerCase() &&
      (verifiedTargets.size === 0 ||
        verifiedTargets.has(deployment.serviceGroupName)),
  );
  const deploymentHistory = (srmStatus?.deploymentHistory ?? []).filter(
    (deployment) =>
      comparison.serviceTreeId &&
      deployment.serviceTreeId.toLocaleLowerCase() ===
        comparison.serviceTreeId.toLocaleLowerCase() &&
      (verifiedTargets.size === 0 ||
        verifiedTargets.has(deployment.serviceGroupName)),
  );
  const groupIds = new Set([
    ...verifiedTargets.keys(),
    ...deployments.map((deployment) => deployment.serviceGroupName),
  ]);

  return [...groupIds]
    .map((serviceGroupId) => {
      const target = verifiedTargets.get(serviceGroupId);
      return {
        deployments: deployments
          .filter(
            (deployment) =>
              deployment.serviceGroupName === serviceGroupId,
          )
          .sort((left, right) =>
            left.environment.localeCompare(right.environment),
          ),
        history: deploymentHistory
          .filter(
            (deployment) =>
              deployment.serviceGroupName === serviceGroupId,
          )
          .sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() -
              new Date(left.updatedAt).getTime(),
          )
          .slice(0, 10),
        displayName: target?.displayName ?? serviceGroupId,
        infrastructures: target?.infrastructures ?? [],
        serviceGroupId,
        sourceUrl: target?.sourceUrl,
        verified: Boolean(target),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function DeploymentDiffsPage() {
  const initialCache = readBrowserCache<{
    response: DeploymentDiffsResponse;
    srmStatus: SrmStatusResponse;
  }>("deployment-diffs");
  const [response, setResponse] = useState<DeploymentDiffsResponse | undefined>(
    initialCache?.value.response,
  );
  const [srmStatus, setSrmStatus] = useState<SrmStatusResponse | undefined>(
    initialCache?.value.srmStatus,
  );
  const [followedServiceGroups, setFollowedServiceGroups] = useState<string[]>(
    readFollowedServiceGroups,
  );
  const [serviceGroupView, setServiceGroupView] = useState<ServiceGroupView>(
    () => (readFollowedServiceGroups().length > 0 ? "following" : "all"),
  );
  const [deploymentUpdates, setDeploymentUpdates] = useState<
    DeploymentUpdate[]
  >([]);
  const [query, setQuery] = useState("");
  const [cloudFilter, setCloudFilter] = useState<"all" | TargetCloud>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | ComparisonRisk>("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");

  async function loadComparisons(refresh = false) {
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams();
      if (refresh) parameters.set("refresh", "true");
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
      const [apiResponse, srmResponse] = await Promise.all([
        fetch(`/__grounds/deployment-diffs${suffix}`),
        fetch(`/__grounds/srm-release-status${suffix}`),
      ]);
      const comparisonResult =
        await readApi<DeploymentDiffsResponse>(apiResponse);
      const srmResult = await readApi<SrmStatusResponse>(srmResponse);
      setResponse(comparisonResult);
      const detectedUpdates = captureDeploymentUpdates(
        srmResult.serviceGroups,
      );
      setDeploymentUpdates((current) =>
        mergeDeploymentUpdates(current, detectedUpdates),
      );
      setSrmStatus(srmResult);
      writeBrowserCache("deployment-diffs", {
        response: comparisonResult,
        srmStatus: srmResult,
      });
    } catch (comparisonError) {
      setError(
        comparisonError instanceof Error
          ? comparisonError.message
          : "Could not load deployment comparisons.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialCache) void loadComparisons();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      followedServiceGroupsStorageKey,
      JSON.stringify(followedServiceGroups),
    );
  }, [followedServiceGroups]);

  function toggleServiceGroupFollow(key: string) {
    setFollowedServiceGroups((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : [...current, key],
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const comparisons = useMemo(
    () =>
      [...(response?.comparisons ?? [])]
        .filter((comparison) => {
          if (
            statusFilter !== "all" &&
            (statusFilter === "available") !==
              (comparison.status === "available")
          ) {
            return false;
          }
          if (
            riskFilter !== "all" &&
            comparison.risk !== riskFilter
          ) {
            return false;
          }
          if (
            cloudFilter !== "all" &&
            !comparison.environments.includes(cloudFilter)
          ) {
            return false;
          }
          const groups = serviceGroupEntries(
            comparison,
            srmStatus,
          );
          if (
            serviceGroupView === "following" &&
            !groups.some((group) =>
              followedServiceGroups.includes(
                serviceGroupFollowKey(comparison, group.serviceGroupId),
              ),
            )
          ) {
            return false;
          }
          if (!normalizedQuery) return true;
          return [
            comparison.serviceDisplayName,
            comparison.pipelineName,
            comparison.definitionName,
            comparison.repository,
            comparison.current?.buildNumber,
            comparison.previous?.buildNumber,
            ...groups.map((group) => group.serviceGroupId),
            ...(comparison.changes ?? []).map((change) => change.path),
            ...(comparison.commits ?? []).map((commit) => commit.comment),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
        .sort(
          (left, right) =>
            focusChangeCount(right) - focusChangeCount(left) ||
            Number(right.status === "available") -
              Number(left.status === "available") ||
            left.serviceDisplayName.localeCompare(right.serviceDisplayName),
        ),
    [
      cloudFilter,
      normalizedQuery,
      response,
      riskFilter,
      followedServiceGroups,
      serviceGroupView,
      srmStatus,
      statusFilter,
    ],
  );

  const available =
    response?.comparisons.filter(
      (comparison) => comparison.status === "available",
    ) ?? [];
  const focusComparisons = available.filter(
    (comparison) => focusChangeCount(comparison) > 0,
  );
  const changedFiles = available.reduce(
    (total, comparison) => total + (comparison.changeCount ?? 0),
    0,
  );
  const followedDeploymentUpdates = deploymentUpdates.filter((update) =>
    (response?.comparisons ?? []).some(
      (comparison) =>
        comparison.serviceTreeId?.toLocaleLowerCase() ===
          update.serviceTreeId.toLocaleLowerCase() &&
        followedServiceGroups.includes(
          serviceGroupFollowKey(comparison, update.serviceGroupName),
        ),
    ),
  );

  return (
    <main className="content deployment-diffs-content">
      <section className="deployment-diffs-hero">
        <div>
          <span className="eyebrow">Build and deployment evidence</span>
          <h1>Deployment diffs</h1>
          <p>
            Compare the latest two successful builds for each cataloged service
            pipeline, prioritize USSec, USNat, and Fairfax changes, and inspect
            captured SRM context without confusing build evidence with confirmed
            deployment lineage.
          </p>
        </div>
        <button
          disabled={loading}
          onClick={() => void loadComparisons(true)}
          type="button"
        >
          {loading ? "Comparing..." : "Refresh comparisons"}
        </button>
      </section>

      <aside className="deployment-evidence-notice">
        <strong>Evidence boundary</strong>
        <p>
          Grounds marks exact lineage only when an SRM release contains the
          compared Azure DevOps build number. Unmatched deployment observations
          remain contextual and are never presented as proof.
        </p>
      </aside>

      {error && (
        <div className="deployment-diffs-error" role="alert">
          <strong>Deployment comparisons are unavailable.</strong>
          <span>{error}</span>
        </div>
      )}

      {followedDeploymentUpdates.length > 0 && (
        <aside className="deployment-follow-updates" role="status">
          <strong>
            {followedDeploymentUpdates.length} followed deployment{" "}
            {followedDeploymentUpdates.length === 1 ? "change" : "changes"}
          </strong>
          <span>
            Status or release observations changed since your previous refresh.
          </span>
        </aside>
      )}

      {response && (
        <>
          <section
            aria-label="Deployment diff summary"
            className="deployment-diffs-summary"
          >
            <article>
              <span>Build comparisons</span>
              <strong>{available.length}</strong>
              <small>{response.comparisons.length} catalog pipelines</small>
            </article>
            <article>
              <span>AGC / Fairfax changes</span>
              <strong>{focusComparisons.length}</strong>
              <small>Comparisons with environment-relevant paths</small>
            </article>
            <article>
              <span>Changed files</span>
              <strong>{changedFiles}</strong>
              <small>Across resolved build ranges</small>
            </article>
            <article>
              <span>Needs configuration</span>
              <strong>{response.comparisons.length - available.length}</strong>
              <small>Missing definition or two-build baseline</small>
            </article>
          </section>

          <section
            aria-label="Filter deployment comparisons"
            className="deployment-diffs-toolbar"
          >
            <label className="deployment-diffs-search">
              <span>Search comparisons</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search services, pipelines, commits, or changed paths..."
                type="search"
                value={query}
              />
            </label>
            <label>
              <span>Environment</span>
              <select
                onChange={(event) =>
                  setCloudFilter(event.target.value as "all" | TargetCloud)
                }
                value={cloudFilter}
              >
                <option value="all">USSec, USNat, and Fairfax</option>
                <option value="ussec">USSec-capable services</option>
                <option value="usnat">USNat-capable services</option>
                <option value="fairfax">Fairfax-capable services</option>
              </select>
            </label>
            <label>
              <span>Potential impact</span>
              <select
                onChange={(event) =>
                  setRiskFilter(event.target.value as "all" | ComparisonRisk)
                }
                value={riskFilter}
              >
                <option value="all">All impact levels</option>
                <option value="high">High focus</option>
                <option value="medium">Medium focus</option>
                <option value="low">Low focus</option>
              </select>
            </label>
            <label>
              <span>Evidence</span>
              <select
                onChange={(event) => setStatusFilter(event.target.value)}
                value={statusFilter}
              >
                <option value="all">Available and missing</option>
                <option value="available">Build comparison available</option>
                <option value="missing">Needs configuration</option>
              </select>
            </label>
            <fieldset className="deployment-follow-filter">
              <legend>Service Groups</legend>
              <div>
                <button
                  aria-pressed={serviceGroupView === "following"}
                  className={serviceGroupView === "following" ? "active" : ""}
                  disabled={followedServiceGroups.length === 0}
                  onClick={() => setServiceGroupView("following")}
                  type="button"
                >
                  Following ({followedServiceGroups.length})
                </button>
                <button
                  aria-pressed={serviceGroupView === "all"}
                  className={serviceGroupView === "all" ? "active" : ""}
                  onClick={() => setServiceGroupView("all")}
                  type="button"
                >
                  All
                </button>
              </div>
            </fieldset>
          </section>

          <div className="deployment-diffs-results-heading">
            <span>
              {comparisons.length} of {response.comparisons.length} comparisons
            </span>
            <small>Updated {formatDate(response.generatedAt)}</small>
          </div>

          {comparisons.length === 0 ? (
            <section className="deployment-diffs-empty">
              <strong>No deployment comparisons match</strong>
              <p>
                Adjust the filters or search text. Environment filters use
                cataloged service capability; impact ranking uses the changed
                paths returned by Azure DevOps.
              </p>
            </section>
          ) : (
            <section
              aria-label="Deployment comparisons"
              className="deployment-diffs-list"
            >
              {comparisons.map((comparison) => (
                <article
                  className={`deployment-comparison ${comparison.status}`}
                  key={`${comparison.serviceName}/${comparison.pipelineName}`}
                >
                  <header>
                    <div>
                      <span>
                        {comparison.repository ?? "Unresolved repository"} ·{" "}
                        {comparison.pipelineName}
                      </span>
                      <h2>
                        <a href={`#/service/${comparison.serviceName}`}>
                          {comparison.serviceDisplayName}
                        </a>
                      </h2>
                    </div>
                    <div className="deployment-comparison-badges">
                      <span className="evidence">Build evidence</span>
                      {comparison.risk && (
                        <span className={`risk ${comparison.risk}`}>
                          {comparison.risk} focus
                        </span>
                      )}
                    </div>
                  </header>

                  {(() => {
                    const groups = serviceGroupEntries(
                      comparison,
                      srmStatus,
                    );
                    const followedGroups = groups.filter((group) =>
                      followedServiceGroups.includes(
                        serviceGroupFollowKey(
                          comparison,
                          group.serviceGroupId,
                        ),
                      ),
                    );
                    const visibleGroups =
                      serviceGroupView === "following"
                        ? followedGroups
                        : [...groups].sort(
                            (left, right) =>
                              Number(
                                followedServiceGroups.includes(
                                  serviceGroupFollowKey(
                                    comparison,
                                    right.serviceGroupId,
                                  ),
                                ),
                              ) -
                                Number(
                                  followedServiceGroups.includes(
                                    serviceGroupFollowKey(
                                      comparison,
                                      left.serviceGroupId,
                                    ),
                                  ),
                                ) ||
                              left.displayName.localeCompare(right.displayName),
                          );
                    return (
                      <section className="deployment-service-groups">
                        <div className="deployment-service-groups-heading">
                          <div>
                            <strong>Service Groups</strong>
                            <span>
                              {followedGroups.length} followed · {groups.length}{" "}
                              available
                            </span>
                          </div>
                          {groups.length > 0 && (
                            <button
                              onClick={() =>
                                setServiceGroupView(
                                  serviceGroupView === "all"
                                    ? "following"
                                    : "all",
                                )
                              }
                              type="button"
                            >
                              {serviceGroupView === "all"
                                ? "Show following"
                                : "Browse all"}
                            </button>
                          )}
                        </div>
                        <p>
                          Follow the deployment units relevant to you. Statuses are
                          current SRM observations; build-to-rollout lineage is not
                          implied.
                        </p>
                        {visibleGroups.length > 0 ? (
                          <div className="deployment-service-group-list">
                            {visibleGroups.map((group) => {
                              const followKey = serviceGroupFollowKey(
                                comparison,
                                group.serviceGroupId,
                              );
                              const isFollowed =
                                followedServiceGroups.includes(followKey);
                              const groupParity = paritySummary(
                                group.deployments,
                                comparison,
                                srmStatus,
                              );
                              return (
                                <article
                                  className={isFollowed ? "followed" : ""}
                                  key={group.serviceGroupId}
                                >
                                  <div className="deployment-service-group-identity">
                                    {group.sourceUrl ? (
                                      <a
                                        href={group.sourceUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        {group.displayName}
                                      </a>
                                    ) : (
                                      <strong>{group.displayName}</strong>
                                    )}
                                    <span>
                                      {group.verified
                                        ? "Repository verified"
                                        : "Observed in SRM"}
                                    </span>
                                    <span className="service-group-parity">
                                      {groupParity}
                                    </span>
                                  </div>
                                  <div className="deployment-service-group-statuses">
                                    {group.deployments.length > 0 ? (
                                      group.deployments.map((deployment) => {
                                        const lineage = buildLineage(
                                          deployment,
                                          comparison,
                                          srmStatus,
                                        );
                                        const changed = deploymentUpdates.some(
                                          (update) =>
                                            update.serviceTreeId ===
                                              deployment.serviceTreeId &&
                                            update.serviceGroupName ===
                                              deployment.serviceGroupName &&
                                            update.environment ===
                                              deployment.environment,
                                        );
                                        return (
                                          <span
                                            className={`${statusClass(
                                              deployment.status,
                                            )} ${changed ? "changed" : ""}`}
                                            key={`${deployment.environment}/${deployment.updatedAt}`}
                                            title={`${formatDate(deployment.updatedAt)}${lineage.release ? ` · ${lineage.release.releaseName}` : ""}`}
                                          >
                                            {environmentLabel(
                                              deployment.environment,
                                            )}{" "}
                                            · {deployment.status} ·{" "}
                                            {formatShortDate(deployment.updatedAt)}
                                            <strong
                                              className={`deployment-lineage ${lineage.className}`}
                                            >
                                              {lineage.label}
                                            </strong>
                                            {changed && (
                                              <strong className="deployment-updated">
                                                Changed
                                              </strong>
                                            )}
                                          </span>
                                        );
                                      })
                                    ) : (
                                      <span className="unknown">
                                        No current deployment observation
                                      </span>
                                    )}
                                  </div>
                                  <button
                                    aria-pressed={isFollowed}
                                    className={isFollowed ? "following" : ""}
                                    onClick={() =>
                                      toggleServiceGroupFollow(followKey)
                                    }
                                    type="button"
                                  >
                                    {isFollowed ? "Following" : "Follow"}
                                  </button>
                                  {group.history.length > 0 && (
                                    <details className="deployment-service-group-history">
                                      <summary>
                                        Deployment timeline ({group.history.length})
                                      </summary>
                                      <ol>
                                        {group.history.map((deployment) => {
                                          const lineage = buildLineage(
                                            deployment,
                                            comparison,
                                            srmStatus,
                                          );
                                          return (
                                            <li
                                              key={
                                                deployment.deploymentCorrelationId
                                              }
                                            >
                                              <time dateTime={deployment.updatedAt}>
                                                {formatDate(deployment.updatedAt)}
                                              </time>
                                              <span>
                                                {environmentLabel(
                                                  deployment.environment,
                                                )}{" "}
                                                · {deployment.status}
                                              </span>
                                              <strong
                                                className={`deployment-lineage ${lineage.className}`}
                                              >
                                                {lineage.label}
                                              </strong>
                                              {lineage.release && (
                                                <span>
                                                  {lineage.release.releaseName}
                                                </span>
                                              )}
                                            </li>
                                          );
                                        })}
                                      </ol>
                                    </details>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="deployment-service-groups-empty">
                            <span>
                              {groups.length > 0
                                ? "No Service Groups from this comparison are followed."
                                : "No current or repository-verified Service Group data is available."}
                            </span>
                            {groups.length > 0 && (
                              <button
                                onClick={() => setServiceGroupView("all")}
                                type="button"
                              >
                                Browse Service Groups
                              </button>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })()}

                  {comparison.status !== "available" ||
                  !comparison.current ||
                  !comparison.previous ? (
                    <div className="deployment-comparison-unavailable">
                      <strong>Comparison not available</strong>
                      <span>{comparison.error}</span>
                    </div>
                  ) : (
                    <>
                      <div className="deployment-build-pair">
                        <section>
                          <span>Previous successful build</span>
                          {buildSummary(comparison.previous)}
                        </section>
                        <span aria-hidden="true">→</span>
                        <section>
                          <span>Current successful build</span>
                          {buildSummary(comparison.current)}
                        </section>
                      </div>

                      <div className="deployment-comparison-actions">
                        <a
                          href={comparison.compareUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open Azure DevOps comparison
                        </a>
                        <span>
                          Definition {comparison.definitionId} ·{" "}
                          {comparison.definitionName}
                        </span>
                      </div>

                      <section
                        aria-label="Change summary"
                        className="deployment-change-summary"
                      >
                        <article>
                          <span>Changed files</span>
                          <strong>{comparison.changeCount ?? 0}</strong>
                        </article>
                        <article>
                          <span>Commits</span>
                          <strong>
                            {comparison.aheadCount ??
                              comparison.commits?.length ??
                              0}
                          </strong>
                        </article>
                        <article>
                          <span>Service-scoped</span>
                          <strong>
                            {comparison.serviceScopedChangeCount ?? 0}
                          </strong>
                        </article>
                        <article>
                          <span>Deployment/config</span>
                          <strong>
                            {comparison.deploymentPathChangeCount ?? 0}
                          </strong>
                        </article>
                      </section>

                      {Object.keys(
                        comparison.changeCategoryCounts ?? {},
                      ).length > 0 && (
                        <section className="deployment-semantic-summary">
                          <h3>What changed</h3>
                          <div>
                            {Object.entries(
                              comparison.changeCategoryCounts ?? {},
                            )
                              .sort((left, right) => right[1] - left[1])
                              .map(([category, count]) => (
                                <span key={category}>
                                  {categoryLabel(category)}
                                  <strong>{count}</strong>
                                </span>
                              ))}
                          </div>
                        </section>
                      )}

                      <div className="deployment-cloud-focus">
                        {response.targetClouds.map((cloud) => (
                          <span
                            className={
                              (comparison.environmentChangeCounts?.[cloud] ??
                                0) > 0
                                ? "changed"
                                : ""
                            }
                            key={cloud}
                          >
                            {cloudLabel(cloud)}{" "}
                            {comparison.environmentChangeCounts?.[cloud] ?? 0}
                          </span>
                        ))}
                      </div>

                      <section className="deployment-impact-guidance">
                        <h3>Potential impact guidance</h3>
                        <ul>
                          {comparison.impactReasons?.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </section>

                      {(comparison.srmContext?.length ?? 0) > 0 && (
                        <details className="deployment-srm-context">
                          <summary>
                            Captured SRM context ({comparison.srmContext?.length})
                          </summary>
                          <p>
                            Context only: Grounds has not established that these
                            releases use the compared builds.
                          </p>
                          <ul>
                            {comparison.srmContext?.map((release) => (
                              <li
                                key={`${release.releaseUrl}/${release.serviceGroupId}`}
                              >
                                <a
                                  href={release.releaseUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {release.releaseName}
                                </a>
                                <span>
                                  {release.serviceGroupId ?? "Service Group not captured"}
                                </span>
                                <div>
                                  {release.stages.map((stage) => (
                                    <span
                                      className={`stage ${stage.status}`}
                                      key={`${stage.name}/${stage.cloud}`}
                                    >
                                      {cloudLabel(stage.cloud)} · {stage.name} ·{" "}
                                      {stage.status}
                                    </span>
                                  ))}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      {(comparison.pullRequests?.length ?? 0) > 0 && (
                        <details className="deployment-related-work">
                          <summary>
                            Related pull requests ({comparison.pullRequests?.length})
                          </summary>
                          <ul>
                            {comparison.pullRequests?.map((pullRequest) => (
                              <li key={pullRequest.pullRequestId}>
                                <a
                                  href={pullRequest.url}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  PR {pullRequest.pullRequestId}:{" "}
                                  {pullRequest.title}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      <details className="deployment-related-work">
                        <summary>
                          Commits ({comparison.commits?.length ?? 0})
                        </summary>
                        <ul>
                          {comparison.commits?.map((commit) => (
                            <li key={commit.commitId}>
                              <a
                                href={commit.url}
                                rel="noreferrer"
                                target="_blank"
                              >
                                <code>{commit.commitId.slice(0, 10)}</code>{" "}
                                {commit.comment}
                              </a>
                              <span>
                                {commit.author} · {formatDate(commit.date)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>

                      <details className="deployment-changed-files">
                        <summary>
                          Prioritized changed files (
                          {comparison.changes?.length ?? 0} shown)
                        </summary>
                        <ul>
                          {comparison.changes?.map((change) => (
                            <li key={`${change.changeType}/${change.path}`}>
                              <span className="change-type">
                                {change.changeType}
                              </span>
                              <code>{change.path}</code>
                              <div>
                                {change.environments.map((cloud) => (
                                  <span className="environment" key={cloud}>
                                    {cloudLabel(cloud)}
                                  </span>
                                ))}
                                {change.isDeployment && (
                                  <span>Deployment/config</span>
                                )}
                                {change.isServiceScoped && (
                                  <span>Service path</span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </>
                  )}
                </article>
              ))}
            </section>
          )}
        </>
      )}

      {loading && !response && (
        <section
          aria-busy="true"
          className="deployment-diffs-loading"
          role="status"
        >
          <strong>Resolving catalog build pipelines...</strong>
          <span>
            Grounds is finding Azure DevOps definitions, loading successful
            builds, and comparing their source commits.
          </span>
        </section>
      )}
    </main>
  );
}
