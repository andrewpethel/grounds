export type ServiceDomain =
  | "control-plane"
  | "data-plane"
  | "alerts-management"
  | "aiops";

export interface ServiceIdentity {
  name: string;
  displayName: string;
  description: string;
  serviceType:
    | "control-plane"
    | "data-plane"
    | "management"
    | "monitoring"
    | "frontend"
    | "backend"
    | "shared-platform"
    | "other";
  lifecycle: "development" | "preview" | "production" | "deprecated" | "retired";
  serviceTreeId?: string;
  serviceGroupPatterns?: string[];
  resourceTypes?: string[];
  operationalImpactTier?: "critical" | "high" | "medium" | "low";
}

export interface Version {
  version: string;
  buildId?: string | number;
  commit?: string;
  branch?: string;
  releaseDate?: string;
  artifactName?: string;
  releaseNotesUrl?: string;
}

export interface OperationalImpact {
  summary: string;
  customerBlastRadius: string;
  dependencyFanOut: string;
  notificationPathImpact: string;
  recoveryUrgency: string;
  affectedSystems: string[];
}

export interface Owner {
  name: string;
  role: "service-owner" | "engineering" | "operations" | "security" | "product" | "support" | "other";
  contact?: string;
  serviceTreeId?: string;
}

export interface Repository {
  name: string;
  provider: "azure-devops" | "github" | "other";
  organization?: string;
  project?: string;
  url: string;
  defaultBranch: string;
  purpose:
    | "primary-source"
    | "deployment"
    | "monitoring"
    | "documentation"
    | "infrastructure"
    | "tests"
    | "other";
  paths?: string[];
  checkoutStatus?: "available" | "not-enlisted" | "not-required" | "unknown";
  localPath?: string;
}

export interface Pipeline {
  name: string;
  provider: "azure-devops" | "github-actions" | "ev2" | "cloudseed" | "other";
  definitionId?: string | number;
  url: string;
  pipelineFile?: string;
  artifactName?: string;
  environments?: string[];
  description?: string;
}

export interface Environment {
  name: string;
  cloud:
    | "public"
    | "fairfax"
    | "mooncake"
    | "usnat"
    | "ussec"
    | "bleu"
    | "delos"
    | "govsg"
    | "test"
    | "other";
  region?: string;
  stamp?: string;
  version?: string;
  status: "healthy" | "degraded" | "unhealthy" | "deploying" | "disabled" | "unknown";
  resourceGroup?: string;
  subscriptionId?: string;
}

export interface Dependency {
  service: string;
  direction: "upstream" | "downstream" | "bidirectional";
  purpose: string;
  failureImpact?: string;
  repositoryUrl?: string;
}

export interface ResourceLink {
  title: string;
  type:
    | "architecture"
    | "runbook"
    | "tsg"
    | "onboarding"
    | "api"
    | "deployment"
    | "dashboard"
    | "health-model"
    | "wiki"
    | "other";
  url: string;
  description?: string;
  audience?: string;
}

export interface OperationalChannel {
  name: string;
  platform: "microsoft-teams";
  purpose: "deployment" | "operations" | "on-call" | "support" | "other";
  url: string;
  description?: string;
}

export interface TrainingMaterial {
  title: string;
  format: "video" | "presentation" | "workshop" | "lab" | "document" | "recording" | "other";
  url: string;
  description?: string;
  durationMinutes?: number;
  level?: "introductory" | "intermediate" | "advanced";
}

export interface KnownIssue {
  id: string;
  incidentId?: string | number;
  title: string;
  status: "active" | "mitigated" | "resolved" | "monitoring" | "known-risk" | "unknown";
  severity: "sev0" | "sev1" | "sev2" | "sev3" | "sev4" | "informational";
  firstObserved: string;
  resolvedAt?: string | null;
  affectedEnvironments?: string[];
  affectedVersions?: string[];
  summary: string;
  customerImpact?: string;
  rootCause?: string;
  triggeringDependency?: string;
  mitigation?: string;
  permanentFix?: string;
  evidence?: ResourceLink[];
  relatedIncidents?: string[];
}

export interface ServiceRecord {
  schemaVersion: string;
  lastUpdated?: string;
  service: ServiceIdentity;
  operationalImpact: OperationalImpact;
  currentVersion: Version;
  owners?: Owner[];
  repositories: Repository[];
  pipelines: {
    build: Pipeline[];
    release: Pipeline[];
  };
  environments?: Environment[];
  dependencies?: Dependency[];
  documentation: ResourceLink[];
  trainingMaterials: TrainingMaterial[];
  dashboards?: ResourceLink[];
  operationalChannels?: OperationalChannel[];
  knownIssues: KnownIssue[];
  tags?: string[];
}

export interface CatalogService extends ServiceRecord {
  domain: ServiceDomain;
  sourceFilePath: string;
  sourcePath: string;
}

export interface ServiceValidationError {
  instancePath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface ServiceValidation {
  checkedAt: string;
  errors: ServiceValidationError[];
  sourcePath: string;
  status: "valid" | "invalid";
}

export interface TeamsDeploymentSignal {
  id: string;
  title: string;
  summary: string;
  kind:
    | "deployment-update"
    | "rollout-blocker"
    | "rollback"
    | "capability-update"
    | "incident"
    | "other";
  observedAt: string;
  sourceName: string;
  sourceUrl: string;
  verificationStatus: "unverified";
  clouds?: Environment["cloud"][];
  scope:
    | { type: "catalog" }
    | { type: "services"; serviceNames: string[] };
}

export interface TeamsIntelligenceSnapshot {
  schemaVersion: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  signals: TeamsDeploymentSignal[];
}

export type SrmDeploymentStatus =
  | "completed"
  | "failed"
  | "in-progress"
  | "canceled"
  | "unknown";

export interface SrmStageObservation {
  name: string;
  cloud?: Environment["cloud"];
  status: SrmDeploymentStatus;
  updatedOn?: string;
}

export interface SrmReleaseObservation {
  serviceName: string;
  serviceTreeId: string;
  serviceGroupId?: string;
  releaseId: string;
  releaseName: string;
  releaseUrl: string;
  overallStatus: SrmDeploymentStatus;
  observedAt: string;
  updatedOn?: string;
  stages: SrmStageObservation[];
}

export interface SrmObservations {
  schemaVersion: string;
  generatedAt: string;
  releases: SrmReleaseObservation[];
}

export type Ev2PortalDomain =
  | "net"
  | "microsoft.scloud"
  | "eaglex.ic.gov";

export type Ev2DeploymentStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export interface Ev2ServiceAssociation {
  serviceName: string;
  basis: "portal-metadata" | "repository-config" | "operator-confirmed";
  evidence?: string;
  confirmedAt?: string;
}

export interface Ev2DeploymentObservation {
  deploymentId: string;
  displayName: string;
  status: Ev2DeploymentStatus;
  releaseId?: string;
  buildVersion?: string;
  startedAt?: string;
  updatedAt?: string;
  observedAt: string;
  sourceUrl: string;
}

export interface Ev2ServiceGroup {
  serviceGroupId: string;
  displayName: string;
  sourceUrl: string;
  infrastructures: string[];
  associations: Ev2ServiceAssociation[];
  deployments: Ev2DeploymentObservation[];
}

export interface Ev2ServiceGroupObservation {
  serviceTreeId: string;
  cloud: Environment["cloud"];
  portalDomain: Ev2PortalDomain;
  sourceUrl: string;
  observedAt: string;
  completeness: "complete" | "partial";
  serviceGroups: Ev2ServiceGroup[];
}

export interface Ev2ServiceGroups {
  schemaVersion: string;
  generatedAt: string;
  observations: Ev2ServiceGroupObservation[];
}

export interface WorkNote {
  id: string;
  serviceName: string;
  title: string;
  body: string;
  serviceGroupIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceChatSession {
  id: string;
  serviceName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceChatSource {
  id: number;
  type:
    | "service-catalog"
    | "troubleshooting"
    | "repository"
    | "deployment"
    | "documentation";
  title: string;
  location: string;
  observedAt?: string;
}

export interface ServiceChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  sources: ServiceChatSource[];
  provider?: string;
  createdAt: string;
}

export interface AdoWorkItemResult {
  id: number;
  title: string;
  type: string;
  url: string;
}
