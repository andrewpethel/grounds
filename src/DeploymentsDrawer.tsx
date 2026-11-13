import { useEffect, useMemo, useState } from "react";
import { domainLabel, ev2ServiceGroups, services } from "./data";
import type { CatalogService, ServiceDomain, SrmServiceGroupStatus } from "./types";
import { readBrowserCache, writeBrowserCache } from "./browserCache";
import { deploymentSelectorsMatch, resolveDeploymentOwner as deploymentOwner } from "../tools/deployment-matching.mjs";

interface LiveDeployment extends SrmServiceGroupStatus {
  deploymentCorrelationId: string;
  displayName: string;
}

interface LiveDeploymentsResponse {
  deploymentHistory?: LiveDeployment[];
  generatedAt?: string;
  serviceGroups?: LiveDeployment[];
}

function isActiveDeployment(status: string) {
  const normalized = status.trim().toLowerCase();
  return (
    normalized.includes("pending") ||
    normalized.includes("processing") ||
    normalized.includes("progress") ||
    normalized.includes("running")
  );
}

function isSuccessfulDeployment(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized.includes("complete") || normalized.includes("success");
}

function statusClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes("fail")) return "failed";
  if (isSuccessfulDeployment(status)) return "completed";
  if (isActiveDeployment(status)) return "in-progress";
  return "unknown";
}

function formatEnvironment(environment: string) {
  const normalized = environment.toLowerCase();
  if (normalized === "ussec") return "USSec";
  if (normalized === "usnat") return "USNat";
  if (normalized === "govsg") return "GovSG";
  return environment;
}

function formatReleaseVersion(releaseName: string) {
  return releaseName.match(/^\S+/)?.[0] ?? releaseName;
}

function formatDeploymentTime(value: string) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function serviceGroupRecord(
  serviceTreeId: string,
  serviceGroupName: string,
) {
  return ev2ServiceGroups.observations
    .filter(
      (observation) =>
        observation.cloud === "public" &&
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
  const associations =
    (serviceGroupRecord(
      deployment.serviceTreeId,
      deployment.serviceGroupName,
    )?.associations ?? [])
      .map((association) => association.serviceName);
  return deploymentOwner(services.map((service) => service.service), deployment.serviceTreeId, deployment.serviceGroupName, associations);
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
    readBrowserCache<LiveDeploymentsResponse>("srm-release-status", 5 * 60 * 1000);
  const [response, setResponse] = useState<LiveDeploymentsResponse | undefined>(
    initialCache?.value,
  );
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [selectedTab, setSelectedTab] = useState<
    "active" | "all" | "versions"
  >("all");
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
          ({ deployment, owner }) => owner === scopeServices[0].service.name ||
            (!owner && deploymentSelectorsMatch(scopeServices[0].service, deployment.serviceGroupName) !== false),
        )
      : deploymentsWithOwners.filter(({ owner }) =>
          !owner || scopeServices.some((service) => service.service.name === owner));
  const historyWithOwners = useMemo(
    () =>
      (response?.deploymentHistory ?? [])
        .filter((deployment) =>
          serviceTreeIds.has(deployment.serviceTreeId.toLowerCase()),
        )
        .map((deployment) => ({
          deployment,
          owner: resolveDeploymentOwner(deployment),
        })),
    [response, serviceTreeIds],
  );
  const scopedHistory =
    scopeServices.length === 1
      ? historyWithOwners.filter(
          ({ deployment, owner }) => owner === scopeServices[0].service.name ||
            (!owner && deploymentSelectorsMatch(scopeServices[0].service, deployment.serviceGroupName) !== false),
        )
      : historyWithOwners.filter(({ owner }) =>
          !owner || scopeServices.some((service) => service.service.name === owner));
  const hasSharedDeployments =
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
  const versionRows = useMemo(() => {
    const selectedDeployments = scopedDeployments.filter(({ owner }) =>
      selectedService === "all"
        ? true
        : selectedService === "shared"
          ? !owner
          : owner === selectedService,
    );
    const selectedHistory = scopedHistory.filter(({ owner }) =>
      selectedService === "all"
        ? true
        : selectedService === "shared"
          ? !owner
          : owner === selectedService,
    );
    const latestSuccessful = new Map<string, LiveDeployment>();

    for (const { deployment } of selectedHistory) {
      if (!isSuccessfulDeployment(deployment.status)) continue;
      const key = [
        deployment.serviceTreeId.toLowerCase(),
        deployment.serviceGroupName,
        deployment.environment.toLowerCase(),
      ].join("|");
      const current = latestSuccessful.get(key);
      if (
        !current ||
        new Date(deployment.updatedAt).getTime() >
          new Date(current.updatedAt).getTime()
      ) {
        latestSuccessful.set(key, deployment);
      }
    }

    return selectedDeployments
      .map(({ deployment, owner }) => {
        const key = [
          deployment.serviceTreeId.toLowerCase(),
          deployment.serviceGroupName,
          deployment.environment.toLowerCase(),
        ].join("|");
        const successful = latestSuccessful.get(key);
        const latestVersion = formatReleaseVersion(
          deployment.releaseName || deployment.releaseCorrelationId,
        );
        const successfulVersion = successful
          ? formatReleaseVersion(
              successful.releaseName || successful.releaseCorrelationId,
            )
          : "";
        return {
          component: groupDisplayName(
            deployment.serviceTreeId,
            deployment.serviceGroupName,
          ),
          deployment,
          latestVersion,
          owner,
          successful,
          successfulVersion,
          versionsMatch:
            Boolean(successfulVersion) &&
            successfulVersion === latestVersion,
        };
      })
      .sort((left, right) => {
        const leftOwner =
          scopeServices.find(
            (service) => service.service.name === left.owner,
          )?.service.displayName ?? "Unattributed Service Tree scope";
        const rightOwner =
          scopeServices.find(
            (service) => service.service.name === right.owner,
          )?.service.displayName ?? "Unattributed Service Tree scope";
        return (
          leftOwner.localeCompare(rightOwner) ||
          left.component.localeCompare(right.component) ||
          left.deployment.environment.localeCompare(
            right.deployment.environment,
          )
        );
      });
  }, [
    scopeServices,
    scopedDeployments,
    scopedHistory,
    selectedService,
  ]);
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
      groupedDeploymentEntries(
        visibleDeployments
          .filter(({ owner }) => !owner)
          .map(({ deployment }) => deployment),
      ),
    [visibleDeployments],
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
    setSelectedTab("all");
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
        {scopeServices.length === 1 && deploymentSelectorsMatch(scopeServices[0].service, "") === undefined && (
          <p role="status">Service Tree scope - not narrowed to this service. Unattributed deployments are not evidence of service ownership. Add deploymentMatching to GroundsManifest.json to narrow future onboarding.</p>
        )}
        {scopeServices.length === 1 && deploymentSelectorsMatch(scopeServices[0].service, "") !== undefined &&
          !loading && !error && scopedDeployments.length === 0 && (
          <p role="status">No deployments match this service's deployment selectors. Grounds has not fallen back to the entire Service Tree.</p>
        )}

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
                Unattributed Service Tree scope
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
          <button
            aria-selected={selectedTab === "versions"}
            className={selectedTab === "versions" ? "active" : ""}
            onClick={() => setSelectedTab("versions")}
            role="tab"
            type="button"
          >
            Versions
            <span>{versionRows.length}</span>
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
          ) : selectedTab === "versions" ? (
            versionRows.length === 0 ? (
              <p className="deployments-empty">
                SRM returned no version observations for this scope.
              </p>
            ) : (
              <div className="deployment-version-table-scroll">
                <table className="deployment-version-table">
                  <thead>
                    <tr>
                      {scopeServices.length > 1 && <th>Service</th>}
                      <th>Component</th>
                      <th>Environment</th>
                      <th>Latest observed</th>
                      <th>Last successful</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versionRows.map(
                      ({
                        component,
                        deployment,
                        latestVersion,
                        owner,
                        successful,
                        successfulVersion,
                        versionsMatch,
                      }) => {
                        const ownerLabel =
                          scopeServices.find(
                            (service) => service.service.name === owner,
                          )?.service.displayName ?? "Unattributed Service Tree scope";
                        return (
                          <tr
                            key={`${deployment.serviceTreeId}-${deployment.serviceGroupName}-${deployment.environment}`}
                          >
                            {scopeServices.length > 1 && (
                              <td className="deployment-version-owner">
                                {ownerLabel}
                              </td>
                            )}
                            <td>
                              <strong>{component}</strong>
                              <code>{deployment.serviceGroupName}</code>
                              {!owner && scopeServices.length === 1 && (
                                <small>Unattributed Service Tree scope</small>
                              )}
                            </td>
                            <td>
                              {formatEnvironment(deployment.environment)}
                            </td>
                            <td>
                              <a
                                href={deployment.releaseUrl}
                                rel="noreferrer"
                                target="_blank"
                                title={deployment.releaseName}
                              >
                                {latestVersion}
                              </a>
                              <span
                                className={`srm-deployment-status ${statusClass(deployment.status)}`}
                              >
                                {deployment.status}
                              </span>
                              <time dateTime={deployment.updatedAt}>
                                {formatDeploymentTime(deployment.updatedAt)}
                              </time>
                            </td>
                            <td>
                              {successful ? (
                                <>
                                  <a
                                    href={successful.releaseUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                    title={successful.releaseName}
                                  >
                                    {successfulVersion}
                                  </a>
                                  <span
                                    className={`deployment-version-comparison ${
                                      versionsMatch ? "current" : "behind"
                                    }`}
                                  >
                                    {versionsMatch
                                      ? "Current"
                                      : "Different version"}
                                  </span>
                                  <time dateTime={successful.updatedAt}>
                                    {formatDeploymentTime(successful.updatedAt)}
                                  </time>
                                </>
                              ) : (
                                <span className="deployment-version-missing">
                                  No successful deployment found in the last 180
                                  days
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      },
                    )}
                  </tbody>
                </table>
              </div>
            )
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
                      <span>{domainLabel(service.domain)}</span>
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
                  <h3>Unattributed Service Tree scope</h3>
                  <p>
                    These records share a Service Tree with this scope, but their
                    ownership is not uniquely established. They are not claimed
                    as deployments of the selected service or domain.
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
      backLabel={`${domainLabel(domain)} catalog`}
      onBack={onBack}
      onNavigate={onNavigate}
      scopeServices={services.filter((service) => service.domain === domain)}
      title={domainLabel(domain)}
    />
  );
}
