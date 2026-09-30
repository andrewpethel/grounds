import { useEffect, useMemo, useState } from "react";
import { services } from "./data";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

interface ReportWorkItem {
  active: boolean;
  changedDate: string;
  id: number;
  project: string;
  serviceNames?: string[];
  state: string;
  title: string;
  type: string;
  url: string;
}

interface ReportDeployment {
  environment: string;
  releaseName: string;
  releaseUrl: string;
  serviceGroupName: string;
  serviceNames: string[];
  status: string;
  updatedAt: string;
}

interface DailyEvidence {
  deployments: ReportDeployment[];
  generatedAt: string;
  workItems: ReportWorkItem[];
}

const cloudFilterStorageKey = "grounds-daily-report-clouds";
const sovereignClouds = new Set([
  "fairfax",
  "mooncake",
  "usnat",
  "ussec",
  "bleu",
  "delos",
  "govsg",
]);

function environmentKey(value: string) {
  return value.trim().toLocaleLowerCase();
}

function environmentLabel(value: string) {
  const key = environmentKey(value);
  if (key === "usnat") return "USNat";
  if (key === "ussec") return "USSec";
  if (key === "govsg") return "GovSG";
  const labels: Record<string, string> = {
    bleu: "Bleu",
    canary: "Canary",
    delos: "Delos",
    fairfax: "Fairfax",
    mooncake: "Mooncake",
    prod: "Prod",
    public: "Public",
    test: "Test",
  };
  return labels[key] ?? (value || "Unknown");
}

function readCloudFilter() {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(cloudFilterStorageKey) ?? "null",
    );
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

function isToday(value: string) {
  const date = new Date(value);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function isFailed(status: string) {
  const value = status.toLocaleLowerCase();
  return value.includes("fail") || value.includes("error");
}

function isActive(status: string) {
  const value = status.toLocaleLowerCase();
  return (
    value.includes("pending") ||
    value.includes("processing") ||
    value.includes("progress") ||
    value.includes("running")
  );
}

function serviceRecord(name: string) {
  return services.find((service) => service.service.name === name);
}

export function DailyReportPage() {
  const reportCacheKey = `daily-report:${new Date().toLocaleDateString("en-CA")}`;
  const initialCache = readBrowserCache<DailyEvidence>(reportCacheKey);
  const [evidence, setEvidence] = useState<DailyEvidence | undefined>(
    initialCache?.value,
  );
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [selectedClouds, setSelectedClouds] = useState<string[] | undefined>(
    readCloudFilter,
  );

  async function loadReport(refresh = false) {
    setLoading(true);
    setError("");
    try {
      const suffix = refresh ? "?refresh=true" : "";
      const [workItemsResponse, deploymentsResponse] = await Promise.all([
        fetch(`/__grounds/ado-work-items${suffix}`),
        fetch(`/__grounds/srm-release-status${suffix}`),
      ]);
      const workItemsResult = await workItemsResponse.json();
      const deploymentsResult = await deploymentsResponse.json();
      const failures = [
        !workItemsResponse.ok && (workItemsResult.error ?? "Work items unavailable."),
        !deploymentsResponse.ok &&
          (deploymentsResult.error ?? "Deployment status unavailable."),
      ].filter(Boolean);
      if (failures.length) throw new Error(failures.join(" "));

      const nextEvidence = {
        deployments: (deploymentsResult.deploymentHistory ?? []).filter(
          (deployment: ReportDeployment) => isToday(deployment.updatedAt),
        ),
        generatedAt: new Date().toISOString(),
        workItems: (workItemsResult.workItems ?? []).filter(
          (item: ReportWorkItem) => isToday(item.changedDate),
        ),
      };
      setEvidence(nextEvidence);
      writeBrowserCache(reportCacheKey, nextEvidence);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Today's correlated report is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialCache) void loadReport();
  }, []);

  const availableClouds = useMemo(
    () =>
      [
        ...new Set(
          (evidence?.deployments ?? []).map((deployment) =>
            environmentKey(deployment.environment),
          ),
        ),
      ]
        .filter(Boolean)
        .sort((left, right) => {
          const sovereignDifference =
            Number(sovereignClouds.has(right)) - Number(sovereignClouds.has(left));
          return sovereignDifference || left.localeCompare(right);
        }),
    [evidence],
  );

  useEffect(() => {
    if (!evidence || selectedClouds !== undefined) return;
    setSelectedClouds(
      availableClouds.filter(
        (cloud) => !cloud.includes("test") && !cloud.includes("canary"),
      ),
    );
  }, [availableClouds, evidence, selectedClouds]);

  useEffect(() => {
    if (selectedClouds === undefined) return;
    window.localStorage.setItem(
      cloudFilterStorageKey,
      JSON.stringify(selectedClouds),
    );
  }, [selectedClouds]);

  const report = useMemo(() => {
    const deployments = (evidence?.deployments ?? []).filter(
      (deployment) =>
        selectedClouds === undefined ||
        selectedClouds.includes(environmentKey(deployment.environment)),
    );
    const workItems = evidence?.workItems ?? [];
    const failed = deployments.filter((deployment) => isFailed(deployment.status));
    const active = deployments.filter((deployment) => isActive(deployment.status));
    const completed = deployments.filter(
      (deployment) => !isFailed(deployment.status) && !isActive(deployment.status),
    );
    const affectedNames = [...new Set(failed.flatMap((item) => item.serviceNames))];
    const impacts = affectedNames
      .map(serviceRecord)
      .filter((service) => service !== undefined);
    const relatedWorkItems = workItems.filter((item) =>
      item.serviceNames?.some((name) => affectedNames.includes(name)),
    );
    const highestTier = impacts.some(
      (service) => service.service.operationalImpactTier === "critical",
    )
      ? "critical"
      : impacts.some((service) => service.service.operationalImpactTier === "high")
        ? "high"
        : impacts.length
          ? "medium"
          : "none";

    const summary = failed.length
      ? `${failed.length} failed deployment record${failed.length === 1 ? "" : "s"} require attention today across ${new Set(failed.map((item) => item.serviceGroupName)).size} service group${failed.length === 1 ? "" : "s"}. The highest correlated service impact is ${highestTier}. ${relatedWorkItems.length} work item${relatedWorkItems.length === 1 ? "" : "s"} changed today and map to affected services.`
      : `${deployments.length} deployment record${deployments.length === 1 ? "" : "s"} changed today with no failed SRM deployment detected. ${active.length} deployment${active.length === 1 ? " is" : "s are"} still active, and ${workItems.length} assigned work item${workItems.length === 1 ? " was" : "s were"} updated today.`;

    return { active, completed, failed, impacts, relatedWorkItems, summary, workItems };
  }, [evidence, selectedClouds]);

  function selectPriorityClouds() {
    setSelectedClouds(
      availableClouds.filter(
        (cloud) => !cloud.includes("test") && !cloud.includes("canary"),
      ),
    );
  }

  function toggleCloud(cloud: string) {
    setSelectedClouds((current) => {
      const selected = current ?? availableClouds;
      return selected.includes(cloud)
        ? selected.filter((value) => value !== cloud)
        : [...selected, cloud];
    });
  }

  return (
    <main className="content daily-report-content">
      <section className="daily-report-hero">
        <div>
          <span className="eyebrow">AI operations assistant</span>
          <h1>Today&apos;s correlated report</h1>
          <p>
            An evidence-grounded summary of today&apos;s assigned work, SRM
            deployments, and the catalog impact profile of failed releases.
          </p>
        </div>
        <button disabled={loading} onClick={() => void loadReport(true)}>
          {loading ? "Correlating..." : "Refresh report"}
        </button>
      </section>

      {error && <div className="daily-report-error" role="alert">{error}</div>}

      {evidence && (
        <>
          <section className="daily-cloud-filter" aria-label="Filter report by cloud">
            <div>
              <span className="eyebrow">Cloud focus</span>
              <strong>Show deployments from environments you care about</strong>
              <small>Test and Canary environments are excluded from the default priority view.</small>
            </div>
            <div className="daily-cloud-presets">
              <button onClick={selectPriorityClouds} type="button">Priority</button>
              <button
                onClick={() =>
                  setSelectedClouds(
                    availableClouds.filter((cloud) => sovereignClouds.has(cloud)),
                  )
                }
                type="button"
              >
                Sovereign
              </button>
              <button onClick={() => setSelectedClouds(availableClouds)} type="button">All</button>
            </div>
            <div className="daily-cloud-options">
              {availableClouds.map((cloud) => (
                <button
                  aria-pressed={selectedClouds?.includes(cloud) ?? true}
                  className={`${selectedClouds?.includes(cloud) ?? true ? "selected" : ""}${sovereignClouds.has(cloud) ? " promoted" : ""}`}
                  key={cloud}
                  onClick={() => toggleCloud(cloud)}
                  type="button"
                >
                  {environmentLabel(cloud)}
                </button>
              ))}
            </div>
          </section>

          <section className={`assistant-summary ${report.failed.length ? "attention" : ""}`}>
            <div className="assistant-avatar">AI</div>
            <div>
              <span>Grounded daily synthesis</span>
              <h2>{report.failed.length ? "Deployment risk detected" : "Daily operations summary"}</h2>
              <p>{report.summary}</p>
              <small>
                Generated from live Grounds sources at{" "}
                {new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(
                  new Date(evidence.generatedAt),
                )}
                . No unsupported causes are inferred.
              </small>
            </div>
          </section>

          <section className="daily-report-summary">
            <article><span>Failed deployments</span><strong>{report.failed.length}</strong><small>Changed today</small></article>
            <article><span>Active deployments</span><strong>{report.active.length}</strong><small>Pending or processing</small></article>
            <article><span>Completed deployments</span><strong>{report.completed.length}</strong><small>Other terminal states</small></article>
            <article><span>Work items changed</span><strong>{report.workItems.length}</strong><small>Assigned to signed-in user</small></article>
          </section>

          {report.failed.length > 0 && (
            <section className="daily-report-section">
              <header><span className="eyebrow">Priority review</span><h2>Failed deployments and impact</h2></header>
              <div className="daily-failure-list">
                {report.failed.map((deployment) => {
                  const impactedServices = deployment.serviceNames
                    .map(serviceRecord)
                    .filter((service) => service !== undefined);
                  return (
                    <article key={`${deployment.serviceGroupName}:${deployment.environment}:${deployment.updatedAt}`}>
                      <div className="daily-failure-heading">
                        <div><span>{deployment.status}</span><h3>{deployment.releaseName || deployment.serviceGroupName}</h3></div>
                        {deployment.releaseUrl && <a href={deployment.releaseUrl} rel="noreferrer" target="_blank">Open SRM</a>}
                      </div>
                      <p>{deployment.serviceGroupName} · {environmentLabel(deployment.environment)}</p>
                      <div className="daily-impact-grid">
                        {impactedServices.map((service) => (
                          <div key={service.service.name}>
                            <strong>{service.service.displayName}</strong>
                            <span>{service.service.operationalImpactTier} impact</span>
                            <p>{service.operationalImpact.summary}</p>
                            <small>{service.operationalImpact.customerBlastRadius}</small>
                          </div>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <section className="daily-report-grid">
            <article className="daily-report-section">
              <header><span className="eyebrow">Work correlation</span><h2>{report.failed.length ? "Related work items" : "Today’s work items"}</h2></header>
              <div className="daily-work-list">
                {(report.failed.length ? report.relatedWorkItems : report.workItems).map((item) => (
                  <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                    <span>{item.type} #{item.id} · {item.state}</span>
                    <strong>{item.title}</strong>
                    <small>{item.project}</small>
                  </a>
                ))}
                {(report.failed.length ? report.relatedWorkItems : report.workItems).length === 0 && <p>No directly correlated work items changed today.</p>}
              </div>
            </article>
            <article className="daily-report-section">
              <header><span className="eyebrow">In flight</span><h2>Active deployments</h2></header>
              <div className="daily-deployment-list">
                {report.active.map((deployment) => (
                  <a href={deployment.releaseUrl} key={`${deployment.serviceGroupName}:${deployment.environment}`} rel="noreferrer" target="_blank">
                    <span>{deployment.status}</span>
                    <strong>{deployment.releaseName || deployment.serviceGroupName}</strong>
                    <small>{deployment.serviceGroupName} · {environmentLabel(deployment.environment)}</small>
                  </a>
                ))}
                {report.active.length === 0 && <p>No active SRM deployments changed today.</p>}
              </div>
            </article>
          </section>
        </>
      )}
    </main>
  );
}
