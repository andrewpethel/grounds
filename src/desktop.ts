import type { ServiceRecord, ServiceValidation, Ev2ServiceGroups, SrmObservations, TeamsIntelligenceSnapshot } from "./types";

export interface DesktopSetup {
  id?: string;
  services: Array<{ serviceName: string; serviceTreeId: string }>;
  cloud: "public" | "ussec" | "usnat";
}

export interface ManifestService {
  name: string;
  displayName: string;
  serviceTreeId: string;
  description?: string;
  domain?: string;
  deploymentMatching?: {
    serviceGroupNames?: string[];
    serviceGroupNameContains?: string[];
  };
  sourcePaths?: string[];
  pipelines?: Partial<ServiceRecord["pipelines"]>;
  pipelineMatching?: Partial<Record<"build" | "release", {
    yamlPaths?: string[]; names?: string[]; namePrefixes?: string[]; definitionKeys?: string[];
  }>>;
}

export interface PipelineCandidate {
  key: string;
  name: string;
  definitionId: string;
  repositoryPath: string;
  implementation: "yaml" | "classic-build" | "classic-release";
  pipelineFile?: string;
  url: string;
  stage: "build" | "release" | null;
  status: "matched" | "needs-confirmation" | "unavailable";
  reason: string;
}

export interface PipelineDiscovery {
  schemaVersion: 1;
  services: Record<string, {
    fingerprint: string;
    attemptedAt: string;
    checkedAt?: string;
    error?: string;
    warnings: string[];
    pipelines: ServiceRecord["pipelines"];
    candidates: PipelineCandidate[];
  }>;
}

export interface ManifestPipelineRepository {
  repositoryPath: string;
  name: string;
  pipelines: ServiceRecord["pipelines"];
  revision: string;
}

export interface ManifestCatalog {
  root: string;
  cloud: DesktopSetup["cloud"];
  repositories: Array<{
    localPath: string;
    name: string;
    manifest: { schemaVersion: 1; services: ManifestService[] } | null;
    defaultBranch?: string;
    warnings?: string[];
    error?: string;
  }>;
  services: Array<ManifestService & { repositories: string[]; added: boolean; error?: string }>;
  diagnostics: string[];
}

export interface DesktopRepository {
  canonicalUrl: string;
  localPath: string;
  name: string;
  displayName: string;
  defaultBranch: string;
  pipelineFiles: string[];
  warnings: string[];
  config: {
    candidates: Array<{
      serviceTreeId: string;
      evidence: Array<{
        file: string;
        field: string;
        kind: "service-spec" | "service-model" | "explicit";
        displayName?: string;
        displayNameField?: string;
      }>;
    }>;
    diagnostics: string[];
    scannedFiles: number;
    status: "matched" | "multiple" | "missing" | "review";
    fingerprint: string;
  };
}

export interface DesktopRepositoryScan {
  selectedPath: string;
  status: "pending" | "scanning" | "done" | "error";
  scannedFiles?: number;
  totalFiles?: number;
  repository?: DesktopRepository;
  error?: string;
}

export type DesktopScanEvent =
  | { scanId: number; type: "start"; paths: string[] }
  | { scanId: number; type: "progress"; scan: DesktopRepositoryScan };

export interface DesktopSnapshot {
  catalogEntries: Array<{ record: ServiceRecord; sourceFilePath: string; sourcePath: string }>;
  initialValidation: Record<string, ServiceValidation>;
  ev2ServiceGroupData: Ev2ServiceGroups;
  srmObservationData: SrmObservations;
  teamsIntelligenceSnapshot: TeamsIntelligenceSnapshot;
  pendingOnboarding: DesktopSetup | null;
  manifestPipelineErrors?: Record<string, string>;
  pipelineDiscovery: PipelineDiscovery;
}

export interface DesktopServiceInput {
  serviceName: string;
  displayName: string;
  description: string;
  serviceTreeId: string;
  serviceGroupPatterns: string;
}

export interface DesktopWorkspaceInput {
  confirmed: boolean;
  mappings: Array<{
    repositoryPath: string;
    defaultBranch: string;
    confirmed: boolean;
    services: Array<{ serviceTreeId: string; source: "config" | "manual" }>;
  }>;
  services: DesktopServiceInput[];
  cloud: DesktopSetup["cloud"];
}

export interface DesktopBridge {
  snapshot(): Promise<DesktopSnapshot>;
  availableServices(chooseFolder: boolean): Promise<ManifestCatalog | null>;
  createManifest(input: {
    repositoryPath: string;
    manifest: { schemaVersion: 1; services: ManifestService[] };
    addToGitignore: boolean;
  }): Promise<ManifestCatalog>;
  openManifestWorkspace(input: { serviceNames: string[]; cloud: DesktopSetup["cloud"] }): Promise<DesktopSetup>;
  selectRepositories(scanId: number): Promise<DesktopRepositoryScan[]>;
  saveWorkspace(input: DesktopWorkspaceInput): Promise<DesktopSetup>;
  finishOnboarding(id?: string): Promise<void>;
  manifestPipelines(serviceName: string): Promise<ManifestPipelineRepository[]>;
  discoverPipelines(force: boolean): Promise<PipelineDiscovery>;
  confirmPipeline(input: { serviceName: string; key: string; stage: "build" | "release"; fingerprint: string }): Promise<PipelineDiscovery>;
  updateManifestPipelines(input: {
    serviceName: string;
    repositoryPath: string;
    pipelines: ServiceRecord["pipelines"];
    previousRevision: string;
  }): Promise<void>;
  request(input: { path: string; method: string; body?: string }): Promise<{ status: number; body: string }>;
  onDataChanged(callback: () => void): () => void;
  onRepositoryScan(callback: (event: DesktopScanEvent) => void): () => void;
}

declare global {
  interface Window {
    groundsDesktop?: DesktopBridge;
  }
}

export function installDesktopTransport(bridge: DesktopBridge) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/__grounds/")) {
      return originalFetch(input, init);
    }
    const request = new Request(url, init ?? (input instanceof Request ? input : undefined));
    if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
    const result = await bridge.request({ path: `${url.pathname}${url.search}`, method: request.method, body });
    if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
    return new Response(result.body, { status: result.status, headers: { "Content-Type": "application/json" } });
  };
}
