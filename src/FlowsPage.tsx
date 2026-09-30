import { useMemo, useState } from "react";
import { services } from "./data";
import type { CatalogService, ServiceDomain } from "./types";

const domainLabels: Record<ServiceDomain, string> = {
  "control-plane": "Control plane",
  "data-plane": "Data plane",
  "alerts-management": "Alerts management",
  aiops: "AIOps",
};

interface FlowStage {
  description: string;
  label: string;
  serviceNames: string[];
}

interface Flow {
  description: string;
  stages: FlowStage[];
  title: string;
}

const flows: Flow[] = [
  {
    title: "Alert rule to customer notification",
    description:
      "The primary Azure Alerts path from resource configuration through evaluation, ingestion, persistence, and customer-facing access.",
    stages: [
      {
        label: "Configure",
        description: "ARM resources and alert-rule definitions enter through the unified control plane.",
        serviceNames: ["azure-alerts-one-rp"],
      },
      {
        label: "Evaluate",
        description: "Specialized engines evaluate signals for each supported alert type.",
        serviceNames: [
          "metric-alerts",
          "activity-log-alerts",
          "log-search-alerts",
          "prometheus-alerts",
        ],
      },
      {
        label: "Ingest",
        description: "Fired and resolved alert state is validated, normalized, and regionally routed.",
        serviceNames: ["alerts-ingestion-gateway"],
      },
      {
        label: "Process and deliver",
        description: "Alert state, processing rules, action execution, and notification delivery are coordinated.",
        serviceNames: ["alerts-management-backend"],
      },
      {
        label: "Query and analyze",
        description: "Operators and downstream systems read current, historical, and analytical alert data.",
        serviceNames: ["alerts-query-service", "alerts-management-db-feeder"],
      },
    ],
  },
  {
    title: "Dynamic thresholds and intelligent detection",
    description:
      "Machine-learning services train baselines, execute detectors, and publish intelligent alert results through the wider Alerts platform.",
    stages: [
      {
        label: "Rule and API surface",
        description: "Dynamic Threshold rules and baseline APIs are exposed through the Alerts control plane.",
        serviceNames: ["azure-alerts-one-rp"],
      },
      {
        label: "Model and detect",
        description: "Adaptive metric models and Smart Alert candidates identify anomalous behavior.",
        serviceNames: [
          "dynamic-alerts-nrt",
          "dynamic-alerts-baseline-service",
          "smart-alerts",
        ],
      },
      {
        label: "Execute detectors",
        description: "Versioned detector packages run in the shared Smart Detector runtime.",
        serviceNames: [
          "smart-detector-runtime-environment",
          "failure-anomalies-detector",
        ],
      },
      {
        label: "Publish alert state",
        description: "Detected state joins the Alerts Management processing and notification path.",
        serviceNames: ["alerts-ingestion-gateway", "alerts-management-backend"],
      },
    ],
  },
  {
    title: "Metrics and platform support",
    description:
      "Supporting services produce metrics, maintain consistency, and provide the deployment foundations used by the runtime services.",
    stages: [
      {
        label: "Produce metrics",
        description: "Log-derived and scheduled-query values are transformed into monitorable metrics.",
        serviceNames: ["lami", "kusto-to-metrics"],
      },
      {
        label: "Evaluate signals",
        description: "Metric and query engines consume the resulting telemetry and rule definitions.",
        serviceNames: ["metric-alerts", "log-search-alerts"],
      },
      {
        label: "Maintain state",
        description: "Background synchronization keeps processing rules and backend state consistent.",
        serviceNames: ["alerts-management-synchronizer"],
      },
      {
        label: "Deploy and operate",
        description: "Manifests, shared infrastructure, and operational actions support deployments across clouds.",
        serviceNames: [
          "alerts-management-manifest",
          "alerts-management-infra",
          "alerts-management-geneva-actions",
        ],
      },
    ],
  },
];

function serviceByName(name: string) {
  return services.find((service) => service.service.name === name);
}

function dependencyTarget(name: string) {
  const normalized = name.toLocaleLowerCase();
  return services.find(
    (service) =>
      service.service.name.toLocaleLowerCase() === normalized ||
      service.service.displayName.toLocaleLowerCase() === normalized,
  );
}

function FlowServiceButton({
  name,
  onNavigate,
}: {
  name: string;
  onNavigate: (service: CatalogService) => void;
}) {
  const service = serviceByName(name);
  if (!service) return null;

  return (
    <button
      className={`flow-service-chip ${service.domain}`}
      onClick={() => onNavigate(service)}
      type="button"
    >
      <span>{domainLabels[service.domain]}</span>
      <strong>{service.service.displayName}</strong>
    </button>
  );
}

export function FlowsPage({
  onNavigate,
}: {
  onNavigate: (service: CatalogService) => void;
}) {
  const [domain, setDomain] = useState<ServiceDomain | "all">("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleServices = useMemo(
    () =>
      services.filter((service) => {
        if (domain !== "all" && service.domain !== domain) return false;
        return `${service.service.displayName} ${service.service.description} ${
          service.dependencies?.map((dependency) => dependency.service).join(" ") ?? ""
        }`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [domain, normalizedQuery],
  );
  const declaredDependencyCount = services.reduce(
    (count, service) => count + (service.dependencies?.length ?? 0),
    0,
  );

  return (
    <main className="content flows-page">
      <header className="flows-hero">
        <div>
          <span className="eyebrow">Service architecture</span>
          <h1>Flows</h1>
          <p>
            Follow alert data through the enlisted services, understand each
            service&apos;s role, and inspect its declared upstream and downstream
            relationships.
          </p>
        </div>
        <div className="flows-summary" aria-label="Flow catalog summary">
          <div><strong>{services.length}</strong><span>Enlisted services</span></div>
          <div><strong>{declaredDependencyCount}</strong><span>Declared relationships</span></div>
          <div><strong>{flows.length}</strong><span>Operational flows</span></div>
        </div>
      </header>

      <section className="flow-map-section" aria-labelledby="flow-map-title">
        <div className="flows-section-heading">
          <div>
            <span className="eyebrow">High-level lifecycle</span>
            <h2 id="flow-map-title">How the services work together</h2>
          </div>
          <p>Open any service in a flow to inspect its full operational record.</p>
        </div>
        <div className="flow-map-list">
          {flows.map((flow) => (
            <article className="flow-map-card" key={flow.title}>
              <header>
                <h3>{flow.title}</h3>
                <p>{flow.description}</p>
              </header>
              <div className="flow-stage-track">
                {flow.stages.map((stage, index) => (
                  <div className="flow-stage-group" key={stage.label}>
                    {index > 0 && <span className="flow-stage-arrow" aria-hidden="true">→</span>}
                    <section className="flow-stage">
                      <span className="flow-stage-number">{index + 1}</span>
                      <h4>{stage.label}</h4>
                      <p>{stage.description}</p>
                      <div className="flow-stage-services">
                        {stage.serviceNames.map((name) => (
                          <FlowServiceButton
                            key={name}
                            name={name}
                            onNavigate={onNavigate}
                          />
                        ))}
                      </div>
                    </section>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="flow-catalog-section" aria-labelledby="flow-catalog-title">
        <div className="flows-section-heading">
          <div>
            <span className="eyebrow">Dependency explorer</span>
            <h2 id="flow-catalog-title">All enlisted services</h2>
          </div>
          <p>
            Relationships below come directly from each service&apos;s catalog record.
          </p>
        </div>
        <div className="flow-filters">
          <label>
            <span>Find a service or dependency</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search services..."
              type="search"
              value={query}
            />
          </label>
          <div className="flow-domain-filters" aria-label="Filter services by domain">
            <button
              className={domain === "all" ? "active" : ""}
              onClick={() => setDomain("all")}
              type="button"
            >
              All
            </button>
            {(Object.keys(domainLabels) as ServiceDomain[]).map((value) => (
              <button
                className={domain === value ? "active" : ""}
                key={value}
                onClick={() => setDomain(value)}
                type="button"
              >
                {domainLabels[value]}
              </button>
            ))}
          </div>
        </div>
        <p className="flow-result-count">
          Showing {visibleServices.length} of {services.length} services
        </p>
        <div className="flow-service-grid">
          {visibleServices.map((service) => (
            <article className={`flow-service-card ${service.domain}`} key={service.service.name}>
              <header>
                <span>{domainLabels[service.domain]}</span>
                <button onClick={() => onNavigate(service)} type="button">
                  View service
                </button>
              </header>
              <h3>{service.service.displayName}</h3>
              <p>{service.service.description}</p>
              <div className="flow-dependencies">
                <strong>
                  {service.dependencies?.length
                    ? `${service.dependencies.length} declared ${
                        service.dependencies.length === 1 ? "relationship" : "relationships"
                      }`
                    : "No catalog relationships declared"}
                </strong>
                {service.dependencies?.map((dependency) => {
                  const target = dependencyTarget(dependency.service);
                  return (
                    <div
                      className={`flow-dependency ${dependency.direction}`}
                      key={`${dependency.direction}-${dependency.service}`}
                    >
                      <span>{dependency.direction}</span>
                      {target ? (
                        <button onClick={() => onNavigate(target)} type="button">
                          {dependency.service}
                        </button>
                      ) : (
                        <b>{dependency.service}</b>
                      )}
                      <p>{dependency.purpose}</p>
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
        {visibleServices.length === 0 && (
          <div className="flow-empty" role="status">
            No services match the current filters.
          </div>
        )}
      </section>
    </main>
  );
}
