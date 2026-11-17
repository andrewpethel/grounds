import { useEffect, useRef } from "react";
import { evidence, type EvidenceId } from "./scenario";

export function EvidenceButton({ id, onSelect, compact = false }: {
  id: EvidenceId;
  onSelect: (id: EvidenceId) => void;
  compact?: boolean;
}) {
  const source = evidence[id];
  return <button className={compact ? "citation" : "evidence-button"} onClick={() => onSelect(id)}
    aria-label={`Read evidence ${source.number}: ${source.title}`}>
    <span>[{source.number}]</span>{!compact && source.title}
  </button>;
}

export function EvidencePanel({ id, onClose }: { id: EvidenceId; onClose: () => void }) {
  const source = evidence[id];
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, [id]);
  return <section id="demo-evidence" className="evidence-panel" aria-label="Evidence details" tabIndex={-1} ref={panel}>
    <div className="section-heading">
      <div><p className="eyebrow">Fictional evidence / {source.kind}</p><h2>[{source.number}] {source.title}</h2></div>
      <button className="quiet-button" onClick={onClose}>Close evidence</button>
    </div>
    <p>{source.summary}</p>
    <p className="source-location">{source.location}</p>
    <pre><code>{source.excerpt}</code></pre>
    <p className="muted">{source.limitation}</p>
  </section>;
}
