import { useEffect, useState, type FormEvent } from "react";
import type { Pipeline, ServiceRecord } from "./types";
import type { ManifestPipelineRepository } from "./desktop";

type Pipelines = ServiceRecord["pipelines"];
const stages = ["build", "release"] as const;
const providers: Pipeline["provider"][] = ["azure-devops", "github-actions", "ev2", "cloudseed", "other"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PipelineLinksFields({ pipelines, onChange, disabled = false }: {
  pipelines: Pipelines;
  onChange: (pipelines: Pipelines) => void;
  disabled?: boolean;
}) {
  function update(stage: typeof stages[number], index: number, change: Partial<Pipeline>) {
    onChange({ ...pipelines, [stage]: pipelines[stage].map((pipeline, position) =>
      position === index ? { ...pipeline, ...change } : pipeline) });
  }
  return <div className="manifest-pipeline-fields">
    {stages.map((stage) => <div key={stage}>
      <h4>{stage === "build" ? "Build links" : "Release links"}</h4>
      {pipelines[stage].map((pipeline, index) => <fieldset disabled={disabled} key={index}>
        <legend>{stage === "build" ? "Build" : "Release"} link {index + 1}</legend>
        <label>Name<input aria-label={`${stage} pipeline name ${index + 1}`} required maxLength={150}
          value={pipeline.name} onChange={(event) => update(stage, index, { name: event.target.value })} /></label>
        <label>Provider<select aria-label={`${stage} pipeline provider ${index + 1}`} value={pipeline.provider}
          onChange={(event) => {
            const provider = providers.find((value) => value === event.target.value);
            if (provider) update(stage, index, { provider });
          }}>{providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <label>HTTPS link<input aria-label={`${stage} pipeline URL ${index + 1}`} type="url" required maxLength={2048}
          value={pipeline.url} onChange={(event) => update(stage, index, { url: event.target.value, definitionId: undefined })} /></label>
        <details><summary>Optional pipeline metadata</summary>
          <label>Definition ID<input aria-label={`${stage} pipeline definition ID ${index + 1}`}
            value={pipeline.definitionId ?? ""} placeholder="Read from definitionId in Azure DevOps links"
            onChange={(event) => update(stage, index, { definitionId: event.target.value || undefined })} /></label>
          <label>Pipeline file reference<input aria-label={`${stage} pipeline file ${index + 1}`}
            value={pipeline.pipelineFile ?? ""} placeholder=".pipelines/OneBranch.Official.yml"
            onChange={(event) => update(stage, index, { pipelineFile: event.target.value || undefined })} /></label>
        </details>
        <button type="button" onClick={() => onChange({
          ...pipelines, [stage]: pipelines[stage].filter((_, position) => position !== index),
        })}>Remove {stage} link {index + 1}</button>
      </fieldset>)}
      <button disabled={disabled || pipelines[stage].length >= 100} type="button" onClick={() => onChange({
        ...pipelines, [stage]: [...pipelines[stage], { name: "", provider: "azure-devops", url: "" }],
      })}>Add {stage} link</button>
    </div>)}
  </div>;
}

export function ManifestPipelinesEditor({ serviceName }: { serviceName: string }) {
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<ManifestPipelineRepository[]>([]);
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Pipelines>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    window.groundsDesktop!.manifestPipelines(serviceName).then((values) => {
      if (cancelled) return;
      setBusy(false);
      setRepositories(values);
      setSelected(values[0].repositoryPath);
      setDrafts(Object.fromEntries(values.map((repository) => [repository.repositoryPath, repository.pipelines])));
    }).catch((error: unknown) => {
      if (!cancelled) { setError(message(error)); setBusy(false); }
    });
    return () => { cancelled = true; };
  }, [open, serviceName, reload]);
  async function save(event: FormEvent) {
    event.preventDefault();
    const repository = repositories.find((value) => value.repositoryPath === selected);
    if (!repository) {
      setError("Select a repository manifest before saving pipeline links.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await window.groundsDesktop!.updateManifestPipelines({
        serviceName, repositoryPath: selected, pipelines: drafts[selected], previousRevision: repository.revision,
      });
      window.location.reload();
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  return <details className="manifest-pipelines-editor" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Edit pipeline links</summary>
    <p>Links are maintained in GroundsManifest.json only. Saving changes that manifest, not pipeline YAML, service configuration, or deployment artifacts.</p>
    {error && <><p role="alert">{error}</p>
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload manifests and discard drafts</button></>}
    {busy && <p role="status">Loading or saving pipeline links...</p>}
    {repositories.length > 0 && <form onSubmit={save}>
      <label>Repository manifest<select disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}>
        {repositories.map((repository) => <option key={repository.repositoryPath} value={repository.repositoryPath}>{repository.name}</option>)}
      </select></label>
      <PipelineLinksFields disabled={busy} pipelines={drafts[selected]}
        onChange={(pipelines) => setDrafts((current) => ({ ...current, [selected]: pipelines }))} />
      <p>Save applies to the selected repository. Links from other associated manifests are combined without duplication.</p>
      <button disabled={busy} type="submit">Save pipeline links</button>
    </form>}
  </details>;
}
