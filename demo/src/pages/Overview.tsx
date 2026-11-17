import { EvidenceButton } from "../components";
import { service, type EvidenceId, type PageId } from "../scenario";

export function Overview({ navigate, onEvidence }: {
  navigate: (page: PageId) => void;
  onEvidence: (id: EvidenceId) => void;
}) {
  return <>
    <section className="intro-card">
      <div>
        <p className="eyebrow">A two-minute investigation</p>
        <h2>Why are parcel updates falling behind?</h2>
        <p>A release completed. One environment is degraded. Follow a fictional service from its architecture to the change worth investigating.</p>
        <button className="primary-button" onClick={() => navigate("architecture")}>Start the walkthrough <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div className="intro-sequence" aria-hidden="true">
        <span>Understand</span><i /><span>Compare</span><i /><span>Investigate</span>
      </div>
    </section>

    <div className="metric-grid">
      <div className="metric"><span>Environments</span><strong>2</strong><small>One needs investigation</small></div>
      <div className="metric"><span>East queue age</span><strong className="warning-text">4m 12s</strong><small>Captured sample, not live</small></div>
      <div className="metric"><span>Latest worker release</span><strong>v2.8.1</strong><small>Completed at 14:05 UTC</small></div>
    </div>

    <div className="content-grid">
      <section className="panel">
        <div className="section-heading"><h2>Environment health</h2><span className="tag">Snapshot</span></div>
        <p className="muted">Sample observations at {service.snapshot}.</p>
        <div className="environment">
          <div><strong>prod-east</strong><span>Parcel Worker v2.8.1</span></div>
          <span className="status warning">Degraded</span>
          <p>Oldest queued message <strong>4m 12s</strong></p>
        </div>
        <div className="environment">
          <div><strong>prod-west</strong><span>Parcel Worker v2.8.0</span></div>
          <span className="status healthy">Healthy</span>
          <p>Oldest queued message <strong>8s</strong></p>
        </div>
        <EvidenceButton id="snapshot" onSelect={onEvidence} />
      </section>
      <section className="panel">
        <div className="section-heading"><h2>Service context</h2><span className="tag">Backend</span></div>
        <dl className="metadata">
          <div><dt>Owner</dt><dd>{service.team}</dd></div>
          <div><dt>Repository</dt><dd><code>{service.repository}</code></dd></div>
          <div><dt>Default branch</dt><dd><code>{service.branch}</code></dd></div>
          <div><dt>Processing path</dt><dd>Queue &rarr; Worker &rarr; Tracking store</dd></div>
        </dl>
        <p className="muted">Ownership, repository context, and dependencies in one service-scoped workspace.</p>
        <button className="text-button" onClick={() => navigate("architecture")}>Explore the logical architecture &rarr;</button>
      </section>
    </div>

    <section className="callout">
      <strong>Context, not a root-cause verdict.</strong>
      <p>Deployment timing and a configuration change give us a useful lead. Fresh metrics and runtime evidence are still needed to establish what is happening.</p>
    </section>
  </>;
}
