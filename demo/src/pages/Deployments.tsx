import { useState } from "react";
import { EvidenceButton } from "../components";
import { releases, type EvidenceId } from "../scenario";

export function Deployments({ onEvidence }: { onEvidence: (id: EvidenceId) => void }) {
  const [selectedVersion, setSelectedVersion] = useState("v2.8.1");
  const [view, setView] = useState<"comparison" | "release">("comparison");
  const selected = releases.find((release) => release.version === selectedVersion)!;
  return <>
    <section className="callout warning-callout">
      <strong>Deployment succeeded. Application health still needs investigation.</strong>
      <p>The east rollout completed 15 minutes before the degraded snapshot. This sequence establishes timing, not causation.</p>
    </section>
    <div className="deployment-layout">
      <section className="panel">
        <h2>Worker releases</h2>
        <p className="muted">12 Nov 2026 / fictional history</p>
        <div className="release-list">
          {releases.map((release) => <button key={release.version} aria-pressed={selectedVersion === release.version}
            onClick={() => setSelectedVersion(release.version)}>
            <div className="section-heading"><strong>{release.version}</strong><span className="status healthy">Succeeded</span></div>
            <span>{release.time}</span><p>{release.environments}</p>
            <small>{release.current ? "Latest in east" : "Comparison baseline"}</small>
          </button>)}
        </div>
      </section>
      <section className="panel comparison-panel">
        <div className="section-heading"><h2>{selected.version} / Parcel Worker</h2><span className="tag">Sample data</span></div>
        <p>{selected.description}</p>
        <div className="view-switch" role="group" aria-label="Release detail view">
          <button aria-pressed={view === "comparison"} onClick={() => setView("comparison")}>Configuration comparison</button>
          <button aria-pressed={view === "release"} onClick={() => setView("release")}>Release details</button>
        </div>
        {view === "comparison" ? <>
          <div className="diff-header"><code>deploy/worker.settings.json</code><span>v2.8.0 &rarr; v2.8.1</span></div>
          <pre className="diff" aria-label="Configuration changes between v2.8.0 and v2.8.1"><code><span>{'  {\n    "QueueName": "shipment-events",\n    "VisibilityTimeoutSeconds": 60,\n'}</span><span className="removed">{'-   "MaxConcurrentHandlers": 32,\n'}</span><span className="added">{'+   "MaxConcurrentHandlers": 8,\n'}</span><span>{'    "MaxDeliveryAttempts": 5\n  }'}</span></code></pre>
          <p><strong>Investigation lead:</strong> fewer concurrent handlers may reduce processing capacity. The effective runtime setting and actual workload must be verified.</p>
          <p className="muted">The comparison always shows the same two releases; selecting a release changes its details, not the comparison baseline.</p>
          <EvidenceButton id="diff" onSelect={onEvidence} />
        </> : <>
          <dl className="metadata">
            <div><dt>Version</dt><dd>{selected.version}</dd></div>
            <div><dt>Commit</dt><dd><code>{selected.commit}</code></dd></div>
            <div><dt>Completed</dt><dd>{selected.time}</dd></div>
            <div><dt>Environment context</dt><dd>{selected.environments}</dd></div>
            <div><dt>Pipeline result</dt><dd>Succeeded (not a health check)</dd></div>
          </dl>
          {selected.current ? <EvidenceButton id="release" onSelect={onEvidence} /> : <EvidenceButton id="diff" onSelect={onEvidence} />}
        </>}
      </section>
    </div>
  </>;
}
