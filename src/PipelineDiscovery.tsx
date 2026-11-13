import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PipelineDiscovery, ManifestPipelineRepository } from "./desktop";
import { services } from "./data";
import type { Pipeline } from "./types";

interface DiscoveryContext {
  state: PipelineDiscovery;
  busy: boolean;
  error: string;
  refresh(force: boolean): Promise<void>;
  confirm(serviceName: string, key: string, stage: "build" | "release", fingerprint: string): Promise<void>;
}

const Context = createContext<DiscoveryContext | undefined>(undefined);
export const usePipelineDiscovery = () => useContext(Context);

export function PipelineDiscoveryProvider({ initial, children }: { initial: PipelineDiscovery; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apply = useCallback((value: PipelineDiscovery) => {
    for (const service of services) {
      const entry = value.services[service.service.name];
      if (entry) service.pipelines = entry.pipelines;
    }
    setState(value);
  }, []);
  const refresh = useCallback(async (force: boolean) => {
    setBusy(true);
    setError("");
    try {
      apply(await window.groundsDesktop!.discoverPipelines(force));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [apply]);
  const confirm = useCallback(async (serviceName: string, key: string, stage: "build" | "release", fingerprint: string) => {
    setBusy(true);
    setError("");
    try {
      apply(await window.groundsDesktop!.confirmPipeline({ serviceName, key, stage, fingerprint }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [apply]);
  useEffect(() => { void refresh(false); }, [refresh]);
  return <Context.Provider value={{ state, busy, error, refresh, confirm }}>{children}</Context.Provider>;
}

export function PipelineResolutionControls({ serviceName }: { serviceName: string }) {
  const discovery = usePipelineDiscovery();
  if (!discovery) return null;
  const entry = discovery.state.services[serviceName];
  const review = entry?.candidates.filter((candidate) => candidate.status !== "matched") ?? [];
  return <div className="pipeline-discovery">
    <div className="pipeline-discovery-heading">
      <p role="status">{discovery.busy ? "Verifying pipeline definitions in the background..." :
        entry?.checkedAt ? `Definitions verified ${new Date(entry.checkedAt).toLocaleString()}.` : "Pipeline discovery has not completed successfully yet."}</p>
      <button type="button" disabled={discovery.busy} onClick={() => void discovery.refresh(true)}>Refresh pipelines</button>
    </div>
    <p>YAML deployments appear under Release. Verification checks repository binding and registered YAML; it does not certify production usage or live run status.</p>
    {(discovery.error || entry?.error) && <p role="alert">{discovery.error || entry?.error}</p>}
    {!!entry?.warnings.length && <details><summary>Pipeline reference warnings ({entry.warnings.length})</summary>
      {entry.warnings.map((warning) => <p key={warning}>{warning}</p>)}
    </details>}
    {!!review.length && <details className="pipeline-associations"><summary>Review pipeline associations ({review.length})</summary>
      <div className="two-column-grid">
        {review.map((candidate) => <article className="pipeline-candidate" key={`${candidate.repositoryPath}-${candidate.key}`}>
          <h3><a href={candidate.url} target="_blank" rel="noreferrer">{candidate.name}</a></h3>
          <p>{candidate.implementation} · {candidate.pipelineFile ?? "Classic definition"}</p>
          <p>{candidate.reason}</p>
          {candidate.status !== "unavailable" && <div className="pipeline-candidate-actions">
            {candidate.implementation !== "classic-release" && <button disabled={discovery.busy} type="button"
              onClick={() => void discovery.confirm(serviceName, candidate.key, "build", entry.fingerprint)}>Use as build</button>}
            <button disabled={discovery.busy} type="button"
              onClick={() => void discovery.confirm(serviceName, candidate.key, "release", entry.fingerprint)}>Use as release</button>
          </div>}
        </article>)}
      </div>
    </details>}
  </div>;
}

export function UnverifiedPipelineReferences({ serviceName, renderPipeline }: {
  serviceName: string;
  renderPipeline(pipeline: Pipeline, stage: "Build" | "Release"): ReactNode;
}) {
  const [repositories, setRepositories] = useState<ManifestPipelineRepository[]>([]);
  const [error, setError] = useState("");
  const discovery = usePipelineDiscovery();
  const entry = discovery?.state.services[serviceName];
  useEffect(() => {
    let cancelled = false;
    window.groundsDesktop!.manifestPipelines(serviceName).then((value) => {
      if (!cancelled) { setRepositories(value); setError(""); }
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [serviceName, entry?.fingerprint]);
  const selected = new Set([...(entry?.pipelines.build ?? []), ...(entry?.pipelines.release ?? [])].map((pipeline) => pipeline.url));
  const references = repositories.flatMap((repository) =>
    (["build", "release"] as const).flatMap((stage) => repository.pipelines[stage]
      .filter((pipeline) => !selected.has(pipeline.url)).map((pipeline) => ({ pipeline, stage, repositoryPath: repository.repositoryPath }))));
  return <details className="pipeline-references">
    <summary>Unverified manifest references ({references.length})</summary>
    <p>These declared links have not been verified and selected. They may be historical, source-file references, or pipeline-name search results.</p>
    {error && <p role="alert">{error}</p>}
    <div className="two-column-grid">{references.map(({ pipeline, stage, repositoryPath }) =>
      <div key={`${repositoryPath}-${stage}-${pipeline.url}`}>{renderPipeline(pipeline, stage === "build" ? "Build" : "Release")}</div>)}</div>
  </details>;
}
