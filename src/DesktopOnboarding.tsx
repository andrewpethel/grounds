import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DesktopSetup, ManifestCatalog, ManifestService } from "./desktop";
import { writeBrowserCache } from "./browserCache";
import "./desktop.css";
import { PipelineLinksFields } from "./ManifestPipelinesEditor";
import type { ServiceRecord } from "./types";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const entries = (value: string) => value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);

function ManifestForm({ repository, onCreated, onError }: {
  repository: ManifestCatalog["repositories"][number];
  onCreated: (catalog: ManifestCatalog) => void;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pipelines, setPipelines] = useState<ServiceRecord["pipelines"]>({ build: [], release: [] });
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const exact = entries(text("exact"));
    const contains = entries(text("contains"));
    const paths = entries(text("paths"));
    const service: ManifestService = {
      name: text("name"), displayName: text("displayName"), serviceTreeId: text("serviceTreeId"),
      ...(text("description") ? { description: text("description") } : {}),
      ...(text("domain") ? { domain: text("domain") } : {}),
      ...(exact.length || contains.length ? {
        deploymentMatching: {
          ...(exact.length ? { serviceGroupNames: exact } : {}),
          ...(contains.length ? { serviceGroupNameContains: contains } : {}),
        },
      } : {}),
      ...(paths.length ? { sourcePaths: paths } : {}),
      ...(pipelines.build.length || pipelines.release.length ? { pipelines } : {}),
    };
    setBusy(true);
    onError("");
    try {
      onCreated(await window.groundsDesktop!.createManifest({
        repositoryPath: repository.localPath,
        manifest: { schemaVersion: 1, services: [service] },
        addToGitignore: data.get("ignore") === "on",
      }));
    } catch (error) {
      onError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <details>
    <summary>Set up {repository.name}</summary>
    <p><code>{repository.localPath}</code></p>
    <form onSubmit={create}>
      <fieldset disabled={busy}>
        <legend>Declare an operator-facing service</legend>
        <label>Service key<input name="name" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="azure-alerts-one-rp" /></label>
        <label>Display name<input name="displayName" required maxLength={150} placeholder="OneRP" /></label>
        <label>Service domain (optional)<input name="domain" maxLength={150} placeholder="Defaults to the service display name" /></label>
        <label>Service Tree ID<input name="serviceTreeId" required placeholder="Service Tree GUID; may be shared by other services" /></label>
        <label>Description (optional)<textarea name="description" maxLength={2000} /></label>
        <details><summary>Build and release links (optional)</summary>
          <PipelineLinksFields pipelines={pipelines} onChange={setPipelines} disabled={busy} />
        </details>
        <details><summary>Deployment matching and source scope (optional)</summary>
          <p>Use comma-separated entries. Entries within a list are alternatives; when both deployment lists are supplied, both must match. Matching is case-insensitive and literal.</p>
          <label>Exact service-group names<textarea name="exact" /></label>
          <label>Service-group name contains<textarea name="contains" placeholder=".AlertsRP" /></label>
          <label>Source paths<textarea name="paths" placeholder="src/OneRP, tests/OneRP" /></label>
        </details>
        <label className="desktop-checkbox"><input type="checkbox" name="ignore" defaultChecked /><span>Add /GroundsManifest.json to this repository's .gitignore</span></label>
        <p>This creates one service declaration without running repository code. Edit the manifest to declare additional services. No credentials or machine-specific state belong in it.</p>
        <button type="submit">{busy ? "Creating manifest..." : "Create GroundsManifest.json"}</button>
      </fieldset>
    </form>
  </details>;
}

export function DesktopOnboarding({ onClose }: { onClose?: () => void }) {
  const bridge = window.groundsDesktop!;
  const [catalog, setCatalog] = useState<ManifestCatalog | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cloud, setCloud] = useState<DesktopSetup["cloud"]>("public");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const initial = useRef<Promise<ManifestCatalog | null> | null>(null);
  useEffect(() => {
    let cancelled = false;
    initial.current ??= bridge.availableServices(false);
    initial.current.then((value) => { if (!cancelled) { setCatalog(value); if (value) setCloud(value.cloud); } })
      .catch((error: unknown) => { if (!cancelled) setError(message(error)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [bridge]);

  function updateCatalog(value: ManifestCatalog) {
    setCatalog(value);
    setSelected((current) => current.filter((name) => value.services.some((service) =>
      service.name === name && !service.added && !service.error)));
  }
  async function scan(chooseFolder: boolean) {
    setBusy(true);
    setError("");
    try {
      const value = await bridge.availableServices(chooseFolder);
      if (value) updateCatalog(value);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function open() {
    setBusy(true);
    setError("");
    try {
      await bridge.openManifestWorkspace({ serviceNames: selected, cloud });
      window.location.reload();
    } catch (error) { setError(message(error)); setBusy(false); }
  }
  const unconfigured = catalog?.repositories.filter((repository) => !repository.manifest || repository.error) ?? [];
  return <div className="desktop-onboarding" role={onClose ? "dialog" : undefined} aria-modal={onClose ? true : undefined} aria-labelledby="desktop-setup-title">
    <main className="desktop-setup-card">
      <header><span className="eyebrow">Grounds for Windows</span><h1 id="desktop-setup-title">Available services</h1>
        <p>Choose services to add to your workspace. GroundsManifest.json declares each service independently of its Service Tree association.</p>
        <div className="desktop-setup-toolbar">
          <button disabled={busy} onClick={() => scan(true)}>Choose repositories folder</button>
          {catalog && <button disabled={busy} onClick={() => scan(false)}>Rescan</button>}
          <button aria-expanded={sidebarOpen} aria-controls="desktop-setup-options" onClick={() => setSidebarOpen((open) => !open)}>Setup options</button>
        </div>
      </header>
      <div className="desktop-setup-layout" data-sidebar-open={sidebarOpen}>
        <section className="desktop-setup-catalog" aria-label="Service catalog">
          {busy && <p role="status">Loading services...</p>}
          {!catalog && !busy && <p>Choose a repositories folder to discover available services.</p>}
          {catalog && <>
            <p className="desktop-setup-root"><code>{catalog.root}</code></p>
            <p>Checks this repository or its immediate child repositories. Your folder is remembered on this Windows account.</p>
            {catalog.diagnostics.map((diagnostic) => <p key={diagnostic} role="status">{diagnostic}</p>)}
            {!catalog.services.length && <p>No configured services found. Use Setup options to create a repository manifest.</p>}
            <ul className="desktop-repository-list">{catalog.services.map((service) => <li key={service.name} data-selected={service.added || selected.includes(service.name)}>
              <label className="desktop-checkbox">
                <input type="checkbox" disabled={busy || service.added || Boolean(service.error)}
                  checked={service.added || selected.includes(service.name)}
                  onChange={(event) => setSelected((current) => event.target.checked ? [...current, service.name] : current.filter((name) => name !== service.name))} />
                <span><strong>{service.displayName}</strong>{service.added ? " - Already in workspace" : ""}</span>
              </label>
              <code>{service.name}</code><span>Service Tree: {service.serviceTreeId}</span>
              <span>Domain: {service.domain ?? service.displayName}</span>
              <span>{service.pipelines?.build?.length ?? 0} build links / {service.pipelines?.release?.length ?? 0} release links</span>
              {service.description && <p>{service.description}</p>}
              <span>{service.repositories.length} {service.repositories.length === 1 ? "repository" : "repositories"}</span>
              <details><summary>Repository and deployment scope</summary>
                {service.repositories.map((repository) => {
                  const details = catalog.repositories.find((row) => row.localPath === repository);
                  return <div key={repository}><p><code>{repository}</code> - branch: {details?.defaultBranch}</p>
                    {details?.warnings?.map((warning) => <p key={warning} role="status">{warning}</p>)}
                  </div>;
                })}
                {service.deploymentMatching
                  ? <><p>Exact names: {service.deploymentMatching.serviceGroupNames?.join(", ") || "Not constrained"}</p>
                    <p>Name contains: {service.deploymentMatching.serviceGroupNameContains?.join(", ") || "Not constrained"}</p></>
                  : <p>Service Tree scope - not narrowed to this service. Deployments are not automatically attributed to it.</p>}
              </details>
              {service.error && <p role="alert">{service.error}</p>}
            </li>)}</ul>
          </>}
        </section>
        <aside className="desktop-setup-sidebar" id="desktop-setup-options" aria-label="Setup options" hidden={!sidebarOpen}>
          <h2>Setup options</h2>
          <label>Deployment cloud<select disabled={busy} value={cloud} onChange={(event) => setCloud(event.target.value as DesktopSetup["cloud"])}>
            <option value="public">Public</option><option value="ussec">USSec</option><option value="usnat">USNat</option>
          </select></label>
          <details><summary>Set up another repository{unconfigured.length ? ` (${unconfigured.length})` : ""}</summary>
            {!catalog
              ? <p>Choose a repositories folder to find repositories to set up.</p>
              : !unconfigured.length && <p>{catalog.repositories.length
                ? "All detected repositories already have a manifest."
                : "No repositories found. Choose a different repositories folder."}</p>}
            {unconfigured.map((repository) => repository.error
              ? <p key={repository.localPath} role="alert"><code>{repository.localPath}</code>: {repository.error} Fix the repository or manifest and rescan.</p>
              : <ManifestForm key={repository.localPath} repository={repository} onCreated={updateCatalog} onError={setError} />)}
          </details>
        </aside>
      </div>
      <footer className="desktop-setup-footer">
        <div className="desktop-setup-footer-copy">
          {error && <p className="desktop-setup-error" role="alert">{error}</p>}
          <p>Repository and deployment status refresh after the workspace opens. EV2 discovery remains available on demand and may require Edge sign-in.</p>
        </div>
        <div className="desktop-setup-actions">
          <button disabled={busy || !selected.length} onClick={open}>Open workspace{selected.length ? ` (${selected.length})` : ""}</button>
          {onClose && <button disabled={busy} onClick={onClose}>Cancel</button>}
        </div>
      </footer>
    </main>
  </div>;
}

type Discovery = {
  label: string;
  path: string;
  cache: "local-repos" | "srm-release-status";
  status: "pending" | "running" | "done" | "error";
  error?: string;
};

export function DesktopDiscovery({ setup }: { setup: DesktopSetup }) {
  const [operations, setOperations] = useState<Discovery[]>([
    { label: "Repository status", path: "/__grounds/local-repos?refresh=true", cache: "local-repos", status: "pending" },
    { label: "SRM deployment status", path: "/__grounds/srm-release-status?refresh=true", cache: "srm-release-status", status: "pending" },
  ]);
  const started = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const completed = operations.every((operation) => operation.status === "done");
  useEffect(() => {
    if (completed) {
      window.groundsDesktop!.finishOnboarding(setup.id)
        .catch((error: unknown) => setError(message(error)));
    }
  }, [completed, setup.id]);
  async function discover(items: Discovery[]) {
    await Promise.all(items.filter((item) => item.status !== "done").map(async (item) => {
      const update = (change: Partial<Discovery>) => setOperations((current) =>
        current.map((operation) => operation.cache === item.cache ? { ...operation, ...change } : operation));
      update({ status: "running", error: undefined });
      try {
        const response = await fetch(item.path);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `Discovery returned ${response.status}.`);
        if (item.cache === "local-repos" && payload.repositories?.some((repository: { status: string }) => repository.status === "error")) {
          throw new Error("Some repositories could not be inspected. Check Git access and retry.");
        }
        writeBrowserCache(item.cache, payload);
        update({ status: "done" });
      } catch (error) { update({ status: "error", error: message(error) }); }
    }));
  }
  useEffect(() => {
    if (!started.current) { started.current = true; void discover(operations); }
  }, [operations]);
  async function dismiss() {
    try {
      await window.groundsDesktop!.finishOnboarding(setup.id);
      setDismissed(true);
    } catch (error) { setError(message(error)); }
  }
  if (dismissed) return null;
  const busy = operations.some((operation) => operation.status === "running" || operation.status === "pending");
  return <aside className="desktop-background-discovery" aria-label="Workspace discovery">
    <strong>Workspace ready</strong>
    {operations.map((operation) => <p key={operation.cache} role={operation.error ? "alert" : "status"}>
      {operation.label}: {operation.status}{operation.error ? ` - ${operation.error}` : ""}
    </p>)}
    <p>Discovery runs independently of service selection. Dismissing this panel does not cancel running requests. Use Refresh to display newly cached status. EV2 service groups can be discovered on demand.</p>
    {error && <p role="alert">{error}</p>}
    {operations.some((operation) => operation.status === "error") && <button disabled={busy} onClick={() => { void discover(operations); }}>Retry failed discovery</button>}
    <button onClick={() => { void dismiss(); }}>Dismiss discovery</button>
  </aside>;
}
