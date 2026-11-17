import { useState } from "react";
import { EvidenceButton } from "../components";
import { architectureEdges, architectureNodes, type EvidenceId } from "../scenario";

export function Architecture({ onEvidence }: { onEvidence: (id: EvidenceId) => void }) {
  const [selectedId, setSelectedId] = useState("worker");
  const selectedNode = architectureNodes.find((node) => node.id === selectedId);
  const selectedEdge = architectureEdges.find((edge) => edge.id === selectedId);
  return <>
    <section className="panel architecture-panel">
      <div className="section-heading">
        <div><h2>Parcel processing flow</h2><p className="muted">Saved logical overview / select a component or relationship</p></div>
        <span className="tag">Illustrative</span>
      </div>
      <div className="diagram-scroll" role="region" aria-label="Scrollable parcel processing diagram" tabIndex={0}>
        <div className="diagram">
          <svg width="900" height="420" viewBox="0 0 900 420" aria-hidden="true">
            <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" /></marker></defs>
            {architectureEdges.map((edge) => <g key={edge.id}>
              <path className="diagram-edge" d={edge.path} markerEnd="url(#arrow)" />
              <text x={edge.x} y={edge.y} textAnchor="middle">{edge.protocol}</text>
            </g>)}
          </svg>
          {architectureNodes.map((node) => <button key={node.id} className={`diagram-node ${node.id === "worker" ? "investigation-node" : ""}`}
            style={{ left: node.x, top: node.y }} onClick={() => setSelectedId(node.id)}
            aria-pressed={selectedId === node.id}>
            <span>{node.kind}</span><strong>{node.name}</strong>
            <small>{node.id === "worker" ? "Configuration changed" : node.id === "queue" ? "Elevated queue age in east" : "Sample component"}</small>
          </button>)}
        </div>
      </div>
      <p className="diagram-caption">Arrows show logical data direction, not deployment placement. Layout is precomputed; no worker or generation runs.</p>
    </section>
    <div className="content-grid architecture-details">
      <section className="panel" aria-label="Selected architecture component or relationship" aria-live="polite">
        <p className="eyebrow">{selectedNode?.kind ?? "Relationship"} / selected</p>
        <h2>{selectedNode?.name ?? selectedEdge?.label}</h2>
        <p>{selectedNode?.description ?? `${architectureNodes.find((node) => node.id === selectedEdge?.source)?.name} sends to ${architectureNodes.find((node) => node.id === selectedEdge?.target)?.name} over ${selectedEdge?.protocol}.`}</p>
        <EvidenceButton id="architecture" onSelect={onEvidence} />
        {(selectedId === "worker" || selectedId === "consume") && <EvidenceButton id="diff" onSelect={onEvidence} />}
      </section>
      <section className="panel">
        <h2>Relationships</h2>
        <div className="relationship-list">
          {architectureEdges.map((edge) => <button key={edge.id} onClick={() => setSelectedId(edge.id)} aria-pressed={selectedId === edge.id}>
            <span>{architectureNodes.find((node) => node.id === edge.source)?.name} &rarr; {architectureNodes.find((node) => node.id === edge.target)?.name}</span>
            <small>{edge.label} / {edge.protocol}</small>
          </button>)}
        </div>
      </section>
    </div>
    <section className="callout"><strong>A useful place to look.</strong><p>The worker sits between the queue and tracking store. Its capacity and downstream latency are relevant leads, not confirmed causes.</p></section>
  </>;
}
