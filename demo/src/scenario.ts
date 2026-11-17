export type PageId = "overview" | "architecture" | "deployments" | "troubleshoot";
export type EvidenceId = "snapshot" | "release" | "diff" | "architecture" | "runbook";
export const evidenceIds: EvidenceId[] = ["snapshot", "release", "diff", "architecture", "runbook"];

export const steps: Array<{ id: PageId; label: string; caption: string; title: string }> = [
  { id: "overview", label: "Service overview", caption: "Start with context", title: "One service. The whole picture." },
  { id: "architecture", label: "Architecture", caption: "Follow the dependencies", title: "See how the pieces connect." },
  { id: "deployments", label: "Deployment changes", caption: "Find what changed", title: "A release is more than a version." },
  { id: "troubleshoot", label: "Troubleshoot", caption: "Bring the evidence together", title: "Less context switching. More understanding." },
];

export const service = {
  name: "Parcel Service",
  description: "Accepts shipment events, queues delivery updates, and keeps parcel tracking records current.",
  team: "Delivery Platform",
  repository: "parcel-service",
  branch: "main",
  snapshot: "12 Nov 2026, 14:20 UTC",
};

interface Evidence {
  number: number;
  title: string;
  kind: string;
  location: string;
  summary: string;
  excerpt: string;
  limitation: string;
}

export const evidence: Record<EvidenceId, Evidence> = {
  snapshot: {
    number: 1,
    title: "Environment observation",
    kind: "Captured snapshot",
    location: "demo/observations/prod-east.json",
    summary: "The east environment has a growing queue; the west environment is healthy in this sample.",
    excerpt: 'capturedAt: 2026-11-12T14:20:00Z\nprod-east: degraded | worker v2.8.1 | oldest message 4m 12s\nprod-west: healthy  | worker v2.8.0 | oldest message 8s',
    limitation: "Fictional point-in-time observations, not live telemetry. The environments are not a controlled experiment.",
  },
  release: {
    number: 2,
    title: "Worker release v2.8.1",
    kind: "Deployment record",
    location: "demo/releases/parcel-worker-2.8.1.json",
    summary: "The sample deployment completed in prod-east at 14:05 UTC, before the captured degraded observation.",
    excerpt: "component: Parcel Worker\nversion: v2.8.1\ncommit: b7e2c91\nenvironment: prod-east\ncompletedAt: 2026-11-12T14:05:00Z\npipelineResult: succeeded",
    limitation: "A successful rollout does not establish application health, and timing alone does not establish causation.",
  },
  diff: {
    number: 3,
    title: "Worker configuration comparison",
    kind: "Repository evidence",
    location: "deploy/worker.settings.json:4",
    summary: "The configured maximum number of concurrent handlers changed from 32 to 8.",
    excerpt: 'comparison: v2.8.0 (a31f902) -> v2.8.1 (b7e2c91)\nfile: deploy/worker.settings.json\n-  "MaxConcurrentHandlers": 32,\n+  "MaxConcurrentHandlers": 8,',
    limitation: "This is a fictional source comparison, not proof of the effective runtime configuration or actual throughput.",
  },
  architecture: {
    number: 4,
    title: "Parcel processing flow",
    kind: "Saved logical architecture",
    location: "docs/parcel-processing.md:12",
    summary: "Parcel Worker consumes the shipment queue and writes tracking records.",
    excerpt: "Partner application -> Parcel API: shipment events (HTTPS)\nParcel API -> Shipment queue: enqueue event (AMQP)\nShipment queue -> Parcel Worker: deliver event (AMQP)\nParcel Worker -> Tracking store: update parcel (SQL)",
    limitation: "An illustrative saved logical overview, not a verified deployment topology or a security diagram.",
  },
  runbook: {
    number: 5,
    title: "Queue delay investigation",
    kind: "Sample runbook",
    location: "docs/runbooks/queue-delay.md:8",
    summary: "Validate traffic, worker capacity, and downstream errors before choosing a mitigation.",
    excerpt: "1. Confirm current queue age, arrival rate, and processing rate.\n2. Compare effective worker settings with the last healthy release.\n3. Check worker errors and downstream latency or throttling.\n4. Review mitigation with the service owner and use the approved change process.\n5. Verify recovery with fresh observations.",
    limitation: "Illustrative investigation guidance only. The demo cannot query metrics, execute commands, or change deployments.",
  },
};

export interface ArchitectureNode {
  id: string;
  name: string;
  kind: string;
  description: string;
  x: number;
  y: number;
}

export const architectureNodes: ArchitectureNode[] = [
  { id: "partner", name: "Partner application", kind: "Application", description: "Submits shipment events to the public API.", x: 30, y: 55 },
  { id: "api", name: "Parcel API", kind: "Service", description: "Validates shipment events and places work on the queue.", x: 330, y: 55 },
  { id: "queue", name: "Shipment queue", kind: "Queue", description: "Buffers delivery updates. Queue age is elevated in the east snapshot.", x: 630, y: 55 },
  { id: "worker", name: "Parcel Worker", kind: "Service", description: "Consumes queued events. Its concurrency setting changed in release v2.8.1.", x: 630, y: 265 },
  { id: "store", name: "Tracking store", kind: "Datastore", description: "Stores the latest parcel tracking state.", x: 330, y: 265 },
];

export const architectureEdges = [
  { id: "submit", source: "partner", target: "api", label: "Shipment events", protocol: "HTTPS", path: "M 250 110 H 330", x: 290, y: 90 },
  { id: "enqueue", source: "api", target: "queue", label: "Enqueue", protocol: "AMQP", path: "M 550 110 H 630", x: 590, y: 90 },
  { id: "consume", source: "queue", target: "worker", label: "Consume", protocol: "AMQP", path: "M 740 165 V 265", x: 787, y: 216 },
  { id: "persist", source: "worker", target: "store", label: "Update tracking", protocol: "SQL", path: "M 630 320 H 550", x: 590, y: 365 },
];

export const releases = [
  { version: "v2.8.1", commit: "b7e2c91", time: "14:05 UTC", environments: "prod-east", description: "Worker concurrency configuration update", current: true },
  { version: "v2.8.0", commit: "a31f902", time: "11:30 UTC", environments: "prod-west; previous in prod-east", description: "Previous release and comparison baseline", current: false },
];

interface AnswerParagraph {
  text: string;
  citations: EvidenceId[];
}

export interface PreparedQuestion {
  id: string;
  question: string;
  heading: string;
  paragraphs: AnswerParagraph[];
  nextSteps: string[];
}

export const questions: PreparedQuestion[] = [
  {
    id: "changed",
    question: "What changed before the queue delay?",
    heading: "A worker configuration change is worth investigating.",
    paragraphs: [
      { text: "The fictional prod-east snapshot shows degraded health and an oldest queued message of 4m 12s at 14:20 UTC. Worker release v2.8.1 completed there at 14:05 UTC.", citations: ["snapshot", "release"] },
      { text: "The source comparison reduces MaxConcurrentHandlers from 32 to 8. The saved flow places Parcel Worker directly on the shipment queue's processing path, so reduced concurrency is a plausible contributor to lower processing capacity.", citations: ["diff", "architecture"] },
      { text: "That is a hypothesis, not a root-cause finding. We do not have current traffic, effective runtime settings, processing rates, worker errors, or downstream latency.", citations: ["snapshot", "runbook"] },
    ],
    nextSteps: ["Confirm the deployed worker's effective concurrency setting.", "Compare arrival and processing rates before and after the rollout.", "Check worker errors and tracking-store latency before selecting a mitigation."],
  },
  {
    id: "scope",
    question: "Which part of the service should I investigate?",
    heading: "Start with the east worker and its processing path.",
    paragraphs: [
      { text: "The sample observation flags prod-east on v2.8.1 while prod-west is healthy on v2.8.0. Use west as a comparison point, not proof that the release caused the east degradation: traffic and capacity may differ.", citations: ["snapshot", "release"] },
      { text: "Follow Shipment queue -> Parcel Worker -> Tracking store in the logical flow. A backlog can reflect insufficient worker capacity, more incoming work, processing failures, or a slower downstream store.", citations: ["architecture", "runbook"] },
      { text: "The supplied evidence does not establish that the API or partner application is unhealthy, nor does it rule out their effect on incoming traffic.", citations: ["snapshot", "architecture"] },
    ],
    nextSteps: ["Check the east queue's age, depth, and arrival rate.", "Inspect worker capacity, errors, and effective settings.", "Compare downstream latency and load between environments."],
  },
  {
    id: "next",
    question: "What should I check before a mitigation?",
    heading: "Validate the hypothesis before changing production.",
    paragraphs: [
      { text: "The sample runbook starts with fresh metrics and effective configuration. The demo's captured observation cannot establish current health or whether the queue is recovering.", citations: ["runbook", "snapshot"] },
      { text: "Review the 32-to-8 concurrency change with the service owner. If live evidence supports it as a contributor, evaluate restoring the previous setting or rolling back through the approved change process; neither action is automatically safe.", citations: ["diff", "release", "runbook"] },
      { text: "After an approved mitigation, confirm that queue age decreases, processing keeps pace with arrivals, and downstream errors do not increase. Grounds' demo does not perform any of these actions.", citations: ["runbook"] },
    ],
    nextSteps: ["Collect current metrics and check downstream capacity.", "Agree on a reviewed mitigation and recovery criteria with the owner.", "Use the normal release process, then verify recovery with new observations."],
  },
];
