import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import process from "node:process";
import { chromium } from "playwright-core";
import { readOperationalJson } from "./operational-data.mjs";

const defaultReleaseUrl =
  "https://srm.azure.com/#/ReleaseStatus/Release/00000000-0000-0000-0000-000000000000";
const targetUrl = new URL(process.argv[2] ?? defaultReleaseUrl);
const supportedSrmHosts = new Set(["srm.azure.com", "bridge.azure.com"]);
const releaseId = targetUrl.hash.split("/").at(-1);
const argumentsByName = new Map(
  process.argv
    .slice(3)
    .filter((argument) => argument.startsWith("--") && argument.includes("="))
    .map((argument) => {
      const separator = argument.indexOf("=");
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
);
const serviceName = argumentsByName.get("service-name");
const expectedServiceTreeId = argumentsByName.get("service-tree-id");
const serviceGroupId = argumentsByName.get("service-group-id");

if (targetUrl.protocol !== "https:" || !supportedSrmHosts.has(targetUrl.hostname)) {
  throw new Error(
    "The SRM collector only accepts https://srm.azure.com or https://bridge.azure.com URLs.",
  );
}

const edgeCandidates = [
  path.join(
    process.env["ProgramFiles(x86)"] ?? "",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
  path.join(
    process.env.ProgramFiles ?? "",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
];

let edgePath;
for (const candidate of edgeCandidates) {
  try {
    await fs.access(candidate);
    edgePath = candidate;
    break;
  } catch {
    // Continue to the next standard installation path.
  }
}

if (!edgePath) {
  throw new Error("Microsoft Edge was not found in a standard installation path.");
}

const groundsRoot = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  "Grounds",
);
const profilePath = path.join(groundsRoot, "browser-profile", "srm");
const captureDirectory = path.join(groundsRoot, "captures");
const observationsPath = path.join(
  process.cwd(),
  "intelligence",
  "srm",
  "release-observations.json",
);
await fs.mkdir(profilePath, { recursive: true });
await fs.mkdir(captureDirectory, { recursive: true });
await fs.mkdir(path.dirname(observationsPath), { recursive: true });

console.log("Opening a dedicated Grounds Edge profile.");
console.log("Complete normal interactive sign-in in the browser if prompted.");
console.log("No cookies or credentials are exported by this tool.");

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: edgePath,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());
const responseMetadata = [];
let releaseApiResponse;

page.on("response", async (response) => {
  const resourceType = response.request().resourceType();
  if (resourceType !== "fetch" && resourceType !== "xhr") return;

  const responseUrl = response.url();
  const parsedResponseUrl = new URL(responseUrl);
  const isSrmEndpoint = supportedSrmHosts.has(parsedResponseUrl.hostname);
  const isReleaseEndpoint =
    parsedResponseUrl.pathname.toLowerCase() ===
    `/api/pipeline/release/${releaseId}`.toLowerCase();
  if (!isSrmEndpoint && !isReleaseEndpoint) return;
  if (parsedResponseUrl.pathname.toLowerCase().startsWith("/api/userprofile")) {
    return;
  }

  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) return;

  responseMetadata.push({
    contentType,
    status: response.status(),
    url: responseUrl,
  });

  if (isReleaseEndpoint && response.ok()) {
    releaseApiResponse = await response.json().catch(() => undefined);
  }
});

await page.goto(targetUrl.href, { waitUntil: "domcontentloaded" });

const deadline = Date.now() + 10 * 60 * 1000;
let visibleText = "";
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  visibleText = await page.locator("body").innerText().catch(() => "");

  const currentHostname = new URL(page.url()).hostname;
  if (supportedSrmHosts.has(currentHostname) && visibleText.length > 500) {
    break;
  }
}

if (visibleText.length <= 500) {
  await context.close();
  throw new Error(
    "The authenticated release page did not become readable within 10 minutes.",
  );
}

const relevantLines = visibleText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) =>
    /release|status|version|build|stage|region|failed|succeeded|rollout/i.test(
      line,
    ),
  )
  .slice(0, 200);
const capture = {
  capturedAt: new Date().toISOString(),
  finalUrl: page.url(),
  pageTitle: await page.title(),
  releaseId,
  releaseApiResponse,
  relevantVisibleText: relevantLines,
  targetUrl: targetUrl.href,
  observedJsonEndpoints: [
    ...new Map(
      responseMetadata.map((response) => [response.url, response]),
    ).values(),
  ],
};
const capturePath = path.join(
  captureDirectory,
  `srm-release-${releaseId}-${Date.now()}.json`,
);

await fs.writeFile(capturePath, JSON.stringify(capture, null, 2), "utf8");

if (serviceName) {
  if (!releaseApiResponse) {
    await context.close();
    throw new Error("The SRM release API response was not captured.");
  }
  if (
    expectedServiceTreeId &&
    releaseApiResponse.serviceTreeId?.toLowerCase() !==
      expectedServiceTreeId.toLowerCase()
  ) {
    await context.close();
    throw new Error(
      `Service Tree mismatch: expected ${expectedServiceTreeId}, received ${releaseApiResponse.serviceTreeId ?? "unknown"}.`,
    );
  }

  const normalizeStatus = (value) => {
    const normalized = String(value ?? "").toLowerCase().replaceAll(" ", "-");
    if (normalized === "completed" || normalized === "succeeded") return "completed";
    if (normalized === "failed") return "failed";
    if (normalized === "in-progress" || normalized === "running") return "in-progress";
    if (normalized === "canceled" || normalized === "cancelled") return "canceled";
    return "unknown";
  };
  const cloudFromStage = (stageName) => {
    const normalized = String(stageName).toLowerCase();
    for (const cloud of [
      "public",
      "fairfax",
      "mooncake",
      "usnat",
      "ussec",
      "bleu",
      "delos",
      "govsg",
      "test",
    ]) {
      if (normalized.includes(cloud)) return cloud;
    }
    return undefined;
  };
  const toIsoDate = (value) => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
  };
  const observations = await readOperationalJson(observationsPath);
  if (!releaseApiResponse.releaseName || !releaseApiResponse.serviceTreeId) {
    await context.close();
    throw new Error("The SRM response is missing release or Service Tree metadata.");
  }
  const observation = {
    serviceName,
    serviceTreeId: releaseApiResponse.serviceTreeId,
    ...(serviceGroupId ? { serviceGroupId } : {}),
    releaseId,
    releaseName: releaseApiResponse.releaseName,
    releaseUrl: targetUrl.href,
    overallStatus: normalizeStatus(
      releaseApiResponse.completionIndicatorString,
    ),
    observedAt: capture.capturedAt,
    ...(toIsoDate(releaseApiResponse.updatedOn)
      ? { updatedOn: toIsoDate(releaseApiResponse.updatedOn) }
      : {}),
    stages: (releaseApiResponse.stages ?? []).map((stage) => ({
      name: stage.stageName,
      ...(cloudFromStage(stage.stageName)
        ? { cloud: cloudFromStage(stage.stageName) }
        : {}),
      status: normalizeStatus(stage.completionIndicatorString),
      ...(toIsoDate(stage.updatedOn)
        ? { updatedOn: toIsoDate(stage.updatedOn) }
        : {}),
    })),
  };
  observations.generatedAt = capture.capturedAt;
  observations.releases = [
    ...observations.releases.filter(
      (existing) =>
        !(
          existing.serviceName === serviceName &&
          existing.releaseId === releaseId
        ),
    ),
    observation,
  ];

  const schema = JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "srm_observations_schema.json"),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(observations)) {
    await context.close();
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"}: ${error.message}`)
      .join("\n");
    throw new Error(`The normalized SRM observation is invalid:\n${details}`);
  }

  const temporaryPath = `${observationsPath}.tmp`;
  await fs.writeFile(
    temporaryPath,
    JSON.stringify(observations, null, 2) + "\n",
    "utf8",
  );
  await fs.rename(temporaryPath, observationsPath);
  console.log(`Updated SRM observation for ${serviceName}.`);
}

console.log(`Captured read-only SRM observations: ${capturePath}`);
console.log(`Page title: ${capture.pageTitle}`);
console.log(`Relevant visible lines: ${capture.relevantVisibleText.length}`);
console.log(`Observed JSON endpoints: ${capture.observedJsonEndpoints.length}`);

await context.close();
