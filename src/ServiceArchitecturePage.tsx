import { useEffect, useRef, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType,
  Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import type { ArchitectureComponent, ArchitectureFlow, CatalogService } from "./types";
import type { ElkNode } from "elkjs/lib/elk-api";
import "@xyflow/react/dist/style.css";
import "./architecture.css";

type DiagramNode = Node<ArchitectureComponent, "architecture">;
type DiagramEdge = Edge<{ path: string; x: number; y: number; text: string }, "architecture">;
interface ArchitectureJob {
  id: string;
  status: "collecting" | "generating" | "cancelling" | "cancelled" | "completed" | "failed";
  error?: string;
}
interface ArchitectureResponse { flow?: ArchitectureFlow; job?: ArchitectureJob }
interface Connection { authenticated: boolean; login?: string; operatorId?: string; error?: string }
class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error ?? "Architecture request failed.", response.status);
  return result as T;
}
function ComponentNode({ data }: NodeProps<DiagramNode>) {
  return (
    <div className={`architecture-component ${data.kind}`} title={data.description}>
      <Handle type="target" position={Position.Left} id="in" />
      <span>{data.kind}</span>
      <strong>{data.label}</strong>
      <p>{data.description}</p>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
function RelationshipEdge({ data, markerEnd, selected }: EdgeProps<DiagramEdge>) {
  if (!data) return null;
  return (
    <>
      <BaseEdge path={data.path} markerEnd={markerEnd} style={{
        stroke: selected ? "var(--accent)" : "var(--muted)", strokeWidth: selected ? 2.5 : 1.8,
      }} />
      <EdgeLabelRenderer>
        <div className="architecture-edge-label" style={{ transform: `translate(${data.x}px, ${data.y}px)` }} title={data.text}>
          {data.text}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { architecture: ComponentNode };
const edgeTypes = { architecture: RelationshipEdge };

async function layout(flow: ArchitectureFlow) {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const input: ElkNode = {
    id: "overview",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "240",
      "elk.spacing.edgeNode": "36",
    },
    children: flow.graph.nodes.map((node) => ({
      id: node.id, width: 240, height: 124,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [
        { id: `${node.id}:in`, x: 0, y: 62, width: 0, height: 0 },
        { id: `${node.id}:out`, x: 240, y: 62, width: 0, height: 0 },
      ],
    })),
    edges: flow.graph.edges.map((edge) => ({
      id: edge.id, sources: [`${edge.source}:out`], targets: [`${edge.target}:in`],
      labels: [{ text: edge.label, width: 190, height: 40 }],
    })),
  };
  const result = await new ELK().layout(input);
  const nodes: DiagramNode[] = flow.graph.nodes.map((node) => {
    const positioned = result.children?.find((entry) => entry.id === node.id);
    if (positioned?.x === undefined || positioned.y === undefined) throw new Error("The layout engine could not position every component.");
    return { id: node.id, type: "architecture", data: node, position: { x: positioned.x, y: positioned.y } };
  });
  const edges: DiagramEdge[] = flow.graph.edges.map((edge) => {
    const routed = result.edges?.find((entry) => entry.id === edge.id);
    if (!routed?.sections?.length) throw new Error("The layout engine could not route every relationship.");
    const path = routed.sections.map((section) => [
      `M ${section.startPoint.x} ${section.startPoint.y}`,
      ...(section.bendPoints ?? []).map((point) => `L ${point.x} ${point.y}`),
      `L ${section.endPoint.x} ${section.endPoint.y}`,
    ].join(" ")).join(" ");
    const label = routed.labels?.[0];
    return {
      id: edge.id, source: edge.source, target: edge.target, sourceHandle: "out", targetHandle: "in",
      type: "architecture", markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)", width: 20, height: 20 },
      data: { path, x: label?.x ?? routed.sections[0].startPoint.x, y: label?.y ?? routed.sections[0].startPoint.y, text: edge.label },
    };
  });
  return { nodes, edges };
}

function ArchitectureDiagram({ flow }: { flow: ArchitectureFlow }) {
  const [diagram, setDiagram] = useState<{ nodes: DiagramNode[]; edges: DiagramEdge[] }>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ label: string; description?: string; evidenceSourceIds: number[] }>();
  useEffect(() => {
    let current = true;
    setDiagram(undefined);
    setError("");
    void layout(flow).then((result) => { if (current) setDiagram(result); })
      .catch((reason: Error) => { if (current) setError(`Diagram layout failed: ${reason.message}`); });
    return () => { current = false; };
  // A flow ID has immutable graph content; polling updates job/review metadata.
  }, [flow.id]);
  return (
    <>
      {error && <p role="alert">{error} The accessible component and relationship list below is still available.</p>}
      {!diagram && !error && <p role="status">Laying out the saved architecture...</p>}
      {diagram && (
        <div className="architecture-canvas" aria-label={`Architecture diagram for ${flow.serviceName}`}>
          <ReactFlow
            key={flow.id} nodes={diagram.nodes} edges={diagram.edges}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.2} maxZoom={2}
            nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
            onNodeClick={(_event, node) => setSelected(node.data)}
            onEdgeClick={(_event, edge) => {
              const relationship = flow.graph.edges.find((entry) => entry.id === edge.id);
              if (relationship) setSelected({ ...relationship, description: relationship.protocol ? `Protocol: ${relationship.protocol}` : "Protocol not established by the available evidence." });
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      <p className="architecture-legend">Logical system overview. Labeled arrows show direction, not deployment placement. Component types are labeled as service, application, datastore, queue, or external. Select a component or relationship to inspect its evidence.</p>
      <details className="architecture-contents">
        <summary>Components and relationships</summary>
        <div>
          {flow.graph.nodes.map((node) => <button key={node.id} onClick={() => setSelected(node)}>{node.label} ({node.kind})</button>)}
          {flow.graph.edges.map((edge) => <button key={edge.id} onClick={() => setSelected({ ...edge, description: edge.protocol ? `Protocol: ${edge.protocol}` : "Protocol not established." })}>
            {flow.graph.nodes.find((node) => node.id === edge.source)?.label} to {flow.graph.nodes.find((node) => node.id === edge.target)?.label}: {edge.label}
          </button>)}
        </div>
      </details>
      {selected && (
        <aside className="architecture-evidence" aria-label="Selected architecture evidence">
          <h3>{selected.label}</h3>
          <p>{selected.description}</p>
          {selected.evidenceSourceIds.map((id) => {
            const source = flow.sources.find((entry) => entry.id === id);
            return source && <div key={id}>
              <p>[{id}] {/^https?:\/\//.test(source.location)
                ? <a href={source.location} target="_blank" rel="noreferrer">{source.title}</a>
                : <span>{source.title}: {source.location}</span>}</p>
              {flow.codeEvidence.filter((entry) => entry.sourceId === id).map((entry) =>
                <pre key={`${entry.path}:${entry.line}`}><code>{entry.path}:{entry.line}{"\n"}{entry.excerpt}</code></pre>)}
            </div>;
          })}
        </aside>
      )}
    </>
  );
}

export function ServiceArchitecturePage({ service, onBack, onTroubleshoot }: {
  service: CatalogService; onBack: () => void; onTroubleshoot: () => void;
}) {
  const [response, setResponse] = useState<ArchitectureResponse>({});
  const [connection, setConnection] = useState<Connection>({ authenticated: false });
  const owner = useRef<string | undefined>(undefined);
  const lifecycle = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/__grounds/service-chat/architecture/${service.service.name}`;
  const running = Boolean(response.job && ["collecting", "generating", "cancelling"].includes(response.job.status));
  const available = service.repositories.some((repository) => repository.checkoutStatus === "available" && repository.localPath);
  async function load(signal?: AbortSignal) {
    try {
      const status = await requestJson<Connection>("/__grounds/service-chat/copilot/status", { signal });
      if (signal?.aborted) return;
      if (owner.current !== status.operatorId) setResponse({});
      owner.current = status.operatorId;
      setConnection(status);
      if (status.authenticated) {
        const result = await requestJson<ArchitectureResponse>(url, { signal });
        if (!signal?.aborted) {
          setResponse(result);
          setError("");
        }
      } else setResponse({});
    } catch (reason) {
      if (signal?.aborted) return;
      if (reason instanceof RequestError && reason.status === 401) {
        setConnection({ authenticated: false });
        setResponse({});
      }
      setError(reason instanceof Error ? reason.message : "Architecture could not be loaded.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [service.service.name]);
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1200);
    }
    timer = setTimeout(() => { void poll(); }, 1200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running, response.job?.id, service.service.name]);
  async function act(method: string, suffix = "", body?: { flowId: string }) {
    const signal = lifecycle.current?.signal;
    setBusy(true);
    setError("");
    try {
      await requestJson(url + suffix, {
        method, signal, headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!signal?.aborted) await load(signal);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Architecture operation failed.");
      if (reason instanceof RequestError && reason.status === 401) {
        setConnection({ authenticated: false });
        setResponse({});
      }
    } finally { if (!signal?.aborted) setBusy(false); }
  }
  const flow = response.flow;
  return (
    <main className="content architecture-page">
      <button className="back-button" onClick={onBack}>Back to service</button>
      <header>
        <span className="eyebrow">Service architecture</span>
        <h1>Architecture flow: {service.service.displayName}</h1>
        <p>Generate a focused logical overview from this service's cataloged repository paths. Nothing is generated during onboarding or app initialization.</p>
      </header>
      <section className="architecture-actions" aria-label="Architecture actions">
        <button disabled={loading || busy || running || !connection.authenticated || !available} onClick={() => void act("POST")}>
          {flow ? "Regenerate Flow" : "Create Flow"}
        </button>
        {running && <button disabled={busy || response.job?.status === "cancelling"} onClick={() => void act("POST", "/cancel")}>Cancel generation</button>}
        {flow && <button disabled={busy || running || flow.status === "reviewed" || flow.catalogChanged} onClick={() => void act("PUT", "", { flowId: flow.id })}>Mark reviewed</button>}
        <button onClick={onTroubleshoot}>{connection.authenticated ? flow ? "Troubleshoot with flow" : "Troubleshoot" : "Connect GitHub Copilot in Troubleshoot"}</button>
        <button disabled={busy || loading} onClick={() => { setError(""); void load(lifecycle.current?.signal); }}>Refresh flow</button>
      </section>
      <p>Only bounded selected-service evidence is sent to GitHub Copilot. Use an organization-approved account. Saved flows are scoped to the connected operator and included in that service's troubleshooting context.</p>
      {connection.error && <p role="alert">{connection.error}</p>}
      {!available && <p role="status">Enlist an available local repository to create an evidence-backed flow.</p>}
      {connection.authenticated && <p>Connected as {connection.login}</p>}
      {loading && <p role="status">Loading saved architecture...</p>}
      {error && <p role="alert">{error}</p>}
      {response.job?.error && <p role="alert">{response.job.error}</p>}
      {running && <p role="status">{response.job?.status === "collecting" ? "Collecting bounded repository evidence..." : response.job?.status === "cancelling" ? "Cancelling architecture generation..." : "Copilot is constructing an evidence-backed architecture draft..."}</p>}
      {response.job?.status === "cancelled" && <p role="status">Generation cancelled. The previous saved flow was not changed.</p>}
      {flow ? (
        <section className="architecture-artifact">
          <header>
            <span className="eyebrow">{flow.status === "draft" ? "AI draft - operator review needed" : "Operator reviewed - not independently verified"}</span>
            <h2>{flow.graph.title}</h2>
            <p>{flow.graph.summary}</p>
            <p>Generated {new Date(flow.generatedAt).toLocaleString()} · System overview · Schema {flow.schemaVersion} · GitHub Copilot</p>
          </header>
          {flow.catalogChanged && <p role="alert">The service configuration changed since generation. This flow may be outdated; regenerate before reviewing it.</p>}
          <p>Source snapshot only: repository changes are not monitored. Regenerate to include later changes.</p>
          <ArchitectureDiagram key={flow.id} flow={flow} />
          <h3>Uncertainties and missing evidence</h3>
          {flow.graph.uncertainties.length
            ? <ul>{flow.graph.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul>
            : <p>No additional uncertainties were reported by the model. This does not establish completeness or correctness.</p>}
          <details>
            <summary>Source snapshot and provenance</summary>
            {flow.repositories.map((repository, index) => <p key={index}>
              {repository.name}: {repository.revision ?? "No resolvable HEAD"}{repository.trackedChanges ? " (tracked working changes present)" : ""}
              {" · Scope: "}{repository.sourcePaths.join(", ") || "Repository tracked files"}
              {repository.limitation && ` · ${repository.limitation}`}
            </p>)}
            <p>Evidence fingerprint: <code>{flow.evidenceFingerprint}</code></p>
          </details>
        </section>
      ) : !loading && connection.authenticated && !running && <p>No saved architecture flow for this service and operator. Create Flow starts the first analysis.</p>}
    </main>
  );
}
