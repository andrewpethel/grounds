import { useEffect, useMemo, useState } from "react";
import { ev2ServiceGroups, services } from "./data";
import type { CatalogService, ServiceDomain } from "./types";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

interface LiveDeployment {
  deploymentCorrelationId: string;
  displayName: string;
  environment: string;
  releaseCorrelationId: string;
  releaseName: string;
  releaseUrl: string;
  serviceGroupName: string;
  serviceTreeId: string;
  status: string;
  updatedAt: string;
}

interface LiveDeploymentsResponse {
  generatedAt?: string;
  serviceGroups?: LiveDeployment[];
}

const domainLabels: Record<ServiceDomain, string> = {
  "control-plane": "Control plane",
  "data-plane": "Data plane",
  "alerts-management": "Alerts management",
  aiops: "AIOps",
};

function isActiveDeployment(status: string) {
  const normalized = status.trim().toLowerCase();
  return (
    normalized.includes("pending") ||
    normalized.includes("processing") ||
    normalized.includes("progress") ||
    normalized.includes("running")
  );
}

function formatEnvironment(environment: string) {
  const normalized = environment.toLowerCase();
  if (normalized === "ussec") return "USSec";
  if (normalized === "usnat") return "USNat";
  if (normalized === "govsg") return "GovSG";
  return environment;
}

function serviceGroupRecord(
  serviceTreeId: string,
  serviceGroupName: string,
) {
  return ev2ServiceGroups.observations
    .filter(
      (observation) =>
        observation.serviceTreeId.toLowerCase() ===
        serviceTreeId.toLowerCase(),
    )
    .flatMap((observation) => observation.serviceGroups)
    .find((group) => group.serviceGroupId === serviceGroupName);
}

function groupDisplayName(serviceTreeId: string, serviceGroupName: string) {
  return (
    serviceGroupRecord(serviceTreeId, serviceGroupName)?.displayName ??
    serviceGroupName
  );
}

function resolveDeploymentOwner(
  deployment: LiveDeployment,
) {
  const servicesForTree = services.filter(
    (service) =>
      service.service.serviceTreeId?.toLowerCase() ===
      deployment.serviceTreeId.toLowerCase(),
  );
  const explicitOwners = new Set(
    (serviceGroupRecord(
      deployment.serviceTreeId,
      deployment.serviceGroupName,
    )?.associations ?? [])
      .map((association) => association.serviceName)
      .filter((name) =>
        servicesForTree.some((service) => service.service.name === name),
      ),
  );
  if (explicitOwners.size === 1) return [...explicitOwners][0];

  const normalizedGroup = deployment.serviceGroupName.toLowerCase();
  const patternMatches = servicesForTree.flatMap((service) =>
    (service.service.serviceGroupPatterns ?? [])
      .filter((pattern) =>
        normalizedGroup.includes(pattern.toLowerCase()),
      )
      .map((pattern) => ({
        length: pattern.length,
        serviceName: service.service.name,
      })),
  );
  const longestMatch = Math.max(
    0,
    ...patternMatches.map((match) => match.length),
  );
  const patternOwners = new Set(
    patternMatches
      .filter((match) => match.length === longestMatch)
      .map((match) => match.serviceName),
  );
  if (patternOwners.size === 1) return [...patternOwners][0];
  if (servicesForTree.length === 1) return servicesForTree[0].service.name;
  return undefined;
}

function groupedDeploymentEntries(deployments: LiveDeployment[]) {
  const groups = new Map<string, LiveDeployment[]>();
  for (const deployment of deployments) {
    const key = `${deployment.serviceTreeId}|${deployment.serviceGroupName}`;
    const current = groups.get(key) ?? [];
    current.push(deployment);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((entries) => ({
      deployments: entries.sort((left, right) => {
        const activeDifference =
          Number(isActiveDeployment(right.status)) -
          Number(isActiveDeployment(left.status));
        return (
          activeDifference ||
          left.environment.localeCompare(right.environment)
        );
      }),
      displayName: groupDisplayName(
        entries[0].serviceTreeId,
        entries[0].serviceGroupName,
      ),
      name: entries[0].serviceGroupName,
      serviceTreeId: entries[0].serviceTreeId,
    }))
    .sort((left, right) => {
      const leftActive = left.deployments.some((deployment) =>
        isActiveDeployment(deployment.status),
      );
      const rightActive = right.deployments.some((deployment) =>
        isActiveDeployment(deployment.status),
      );
      return (
        Number(rightActive) - Number(leftActive) ||
        left.displayName.localeCompare(right.displayName)
      );
    });
}

function DeploymentGroupCard({
  group,
}: {
  group: ReturnType<typeof groupedDeploymentEntries>[number];
}) {
  return (
    <section className="deployment-group">
      <header>
        <div>
          <h3>{group.displayName}</h3>
          <code>{group.name}</code>
        </div>
        <span>{group.deployments.length}</span>
      </header>
      <div>
        {group.deployments.map((deployment) => {
          const active = isActiveDeployment(deployment.status);
          const content = (
            <>
              <span>
                <strong>{formatEnvironment(deployment.environment)}</strong>
                <small>
                  {deployment.releaseName ||
                    deployment.displayName ||
                    deployment.releaseCorrelationId}
                </small>
              </span>
              <span
                className={`srm-deployment-status ${deployment.status.toLowerCase()}`}
              >
                {deployment.status}
              </span>
            </>
          );
          const key = `${deployment.serviceGroupName}-${deployment.environment}`;
          return deployment.releaseUrl ? (
            <a
              className={`deployment-drawer-row${active ? " active" : ""}`}
              href={deployment.releaseUrl}
              key={key}
              rel="noreferrer"
              target="_blank"
            >
              {content}
            </a>
          ) : (
            <div
              className={`deployment-drawer-row${active ? " active" : ""}`}
              key={key}
            >
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DeploymentsScopePage({
  backLabel,
  onBack,
  onNavigate,
  scopeServices,
  title,
}: {
  backLabel: string;
  onBack: () => void;
  onNavigate?: (service: CatalogService) => void;
  scopeServices: CatalogService[];
  title: string;
}) {
  const initialCache =
    readBrowserCache<LiveDeploymentsResponse>("srm-release-status");
  const [response, setResponse] = useState<LiveDeploymentsResponse | undefined>(
    initialCache?.value,
  );
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [selectedTab, setSelectedTab] = useState<"active" | "all">("active");
  const [selectedService, setSelectedService] = useState("all");
  const serviceTreeIds = useMemo(
    () =>
      new Set(
        scopeServices
          .map((service) => service.service.serviceTreeId?.toLowerCase())
          .filter((serviceTreeId): serviceTreeId is string =>
            Boolean(serviceTreeId),
          ),
      ),
    [scopeServices],
  );
  const scopeKey = scopeServices
    .map((service) => service.service.name)
    .sort()
    .join("|");
  const treeDeployments = useMemo(
    () =>
      (response?.serviceGroups ?? []).filter((deployment) =>
        serviceTreeIds.has(deployment.serviceTreeId.toLowerCase()),
      ),
    [response, serviceTreeIds],
  );
  const deploymentsWithOwners = useMemo(
    () =>
      treeDeployments.map((deployment) => ({
        deployment,
        owner: resolveDeploymentOwner(deployment),
      })),
    [treeDeployments],
  );
  const scopedDeployments =
    scopeServices.length === 1
      ? deploymentsWithOwners.filter(
          ({ owner }) => owner === scopeServices[0].service.name,
        )
      : deploymentsWithOwners;
  const hasSharedDeployments =
    scopeServices.length > 1 &&
    scopedDeployments.some(({ owner }) => !owner);
  const activeCount = scopedDeployments.filter(({ deployment }) =>
    isActiveDeployment(deployment.status),
  ).length;
  const visibleDeployments = scopedDeployments.filter(({ deployment, owner }) => {
    if (
      selectedService !== "all" &&
      (selectedService === "shared"
        ? Boolean(owner)
        : owner !== selectedService)
    ) {
      return false;
    }
    return selectedTab === "all" || isActiveDeployment(deployment.status);
  });
  const groupedServices = useMemo(
    () =>
      scopeServices
        .filter(
          (service) =>
            selectedService === "all" ||
            service.service.name === selectedService,
        )
        .map((service) => {
          const serviceDeployments = visibleDeployments
            .filter(({ owner }) => owner === service.service.name)
            .map(({ deployment }) => deployment);
          return {
            service,
            groups: groupedDeploymentEntries(serviceDeployments),
          };
        })
        .filter(({ groups }) => groups.length > 0),
    [scopeServices, selectedService, visibleDeployments],
  );
  const sharedGroups = useMemo(
    () =>
      scopeServices.length > 1
        ? groupedDeploymentEntries(
            visibleDeployments
              .filter(({ owner }) => !owner)
              .map(({ deployment }) => deployment),
          )
        : [],
    [scopeServices.length, visibleDeployments],
  );

  async function loadDeployments(refresh = false, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const apiResponse = await fetch(
        `/__grounds/srm-release-status${refresh ? "?refresh=true" : ""}`,
        { signal },
      );
      const result = (await apiResponse.json()) as LiveDeploymentsResponse & {
        error?: string;
      };
      if (!apiResponse.ok) {
        throw new Error(
          result.error ?? "Current SRM deployments are unavailable.",
        );
      }
      setResponse(result);
      writeBrowserCache("srm-release-status", result);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Current SRM deployments are unavailable.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedService("all");
    if (initialCache) {
      setResponse(initialCache.value);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadDeployments(false, controller.signal);
    return () => controller.abort();
  }, [scopeKey]);

  return (
    <main className="deployments-page">
      <section className="deployments-page-panel">
        <header className="deployments-header">
          <div>
            <button className="back-button" onClick={onBack} type="button">
              ← {backLabel}
            </button>
            <span className="eyebrow">Live SRM status</span>
            <h2 id="deployments-title">Deployments: {title}</h2>
            <p>
              {scopedDeployments.length} current Service Group/environment records
              {activeCount > 0 ? ` · ${activeCount} active` : ""}
              {scopeServices.length > 1
                ? ` · ${scopeServices.length} enlisted services`
                : ""}
            </p>
          </div>
          <div>
            <button
              disabled={loading}
              onClick={() => void loadDeployments(true)}
              type="button"
            >
              {loading ? "Refreshing..." : "Refresh SRM"}
            </button>
          </div>
        </header>

        {scopeServices.length > 1 && (
          <nav
            aria-label="Filter deployments by service"
            className="deployment-service-filters"
          >
            <button
              className={selectedService === "all" ? "active" : ""}
              onClick={() => setSelectedService("all")}
              type="button"
            >
              All services
            </button>
            {scopeServices.map((service) => (
              <button
                className={
                  selectedService === service.service.name ? "active" : ""
                }
                key={service.service.name}
                onClick={() => setSelectedService(service.service.name)}
                type="button"
              >
                {service.service.displayName}
              </button>
            ))}
            {hasSharedDeployments && (
              <button
                className={selectedService === "shared" ? "active" : ""}
                onClick={() => setSelectedService("shared")}
                type="button"
              >
                Shared domain platform
              </button>
            )}
          </nav>
        )}

        <nav aria-label="Deployment views" className="deployments-tabs">
          <button
            aria-selected={selectedTab === "active"}
            className={selectedTab === "active" ? "active" : ""}
            onClick={() => setSelectedTab("active")}
            role="tab"
            type="button"
          >
            Active
            <span>{activeCount}</span>
          </button>
          <button
            aria-selected={selectedTab === "all"}
            className={selectedTab === "all" ? "active" : ""}
            onClick={() => setSelectedTab("all")}
            role="tab"
            type="button"
          >
            All current
            <span>{scopedDeployments.length}</span>
          </button>
        </nav>

        <div className="deployments-content">
          {error && (
            <div className="deployments-error" role="alert">
              {error}
            </div>
          )}
          {loading && scopedDeployments.length === 0 ? (
            <p className="deployments-empty">Loading current SRM deployments...</p>
          ) : groupedServices.length === 0 && sharedGroups.length === 0 ? (
            <p className="deployments-empty">
              {selectedTab === "active"
                ? "No deployments are currently pending or processing."
                : "SRM returned no current deployments for this scope."}
            </p>
          ) : (
            groupedServices.map(({ service, groups }) => (
              <section
                className="domain-deployment-service"
                key={service.service.name}
              >
                {scopeServices.length > 1 && (
                  <header>
                    <div>
                      <span>{domainLabels[service.domain]}</span>
                      <h3>{service.service.displayName}</h3>
                    </div>
                    {onNavigate && (
                      <button onClick={() => onNavigate(service)} type="button">
                        Open service
                      </button>
                    )}
                  </header>
                )}
                <div className="domain-deployment-groups">
                  {groups.map((group) => (
                    <DeploymentGroupCard
                      group={group}
                      key={`${group.serviceTreeId}-${group.name}`}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
          {sharedGroups.length > 0 && (
            <section className="domain-deployment-service shared">
              <header>
                <div>
                  <span>{title}</span>
                  <h3>Shared domain platform</h3>
                  <p>
                    Service Groups associated with this domain&apos;s shared Service
                    Tree but not uniquely owned by an enlisted service.
                  </p>
                </div>
              </header>
              <div className="domain-deployment-groups">
                {sharedGroups.map((group) => (
                  <DeploymentGroupCard
                    group={group}
                    key={`${group.serviceTreeId}-${group.name}`}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
        {response?.generatedAt && (
          <footer>
            Retrieved{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(response.generatedAt))}
          </footer>
        )}
      </section>
    </main>
  );
}

export function DeploymentsPage({
  onBack,
  service,
}: {
  onBack: () => void;
  service: CatalogService;
}) {
  return (
    <DeploymentsScopePage
      backLabel="Service overview"
      onBack={onBack}
      scopeServices={[service]}
      title={service.service.displayName}
    />
  );
}

export function DomainDeploymentsPage({
  domain,
  onBack,
  onNavigate,
}: {
  domain: ServiceDomain;
  onBack: () => void;
  onNavigate: (service: CatalogService) => void;
}) {
  return (
    <DeploymentsScopePage
      backLabel={`${domainLabels[domain]} catalog`}
      onBack={onBack}
      onNavigate={onNavigate}
      scopeServices={services.filter((service) => service.domain === domain)}
      title={domainLabels[domain]}
    />
  );
}
