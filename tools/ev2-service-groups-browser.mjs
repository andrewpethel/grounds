import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { chromium } from "playwright-core";
import { readOperationalJson } from "./operational-data.mjs";

const serviceTreeId = process.argv[2];
const cloud = process.argv[3];
const domains = {
  public: "net",
  ussec: "microsoft.scloud",
  usnat: "eaglex.ic.gov",
};
const portalDomain = domains[cloud];

if (
  !serviceTreeId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    serviceTreeId,
  )
) {
  throw new Error("A valid Service Tree ID is required.");
}
if (!portalDomain) {
  throw new Error("Service-group discovery supports Public, USSec, and USNat.");
}

const edgeExecutable =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const localAppData =
  process.env.LOCALAPPDATA ??
  path.join(os.homedir(), "AppData", "Local");
const browserProfile = path.join(
  localAppData,
  "Grounds",
  "browser-profile",
  "srm",
);
const targetUrl = `https://ra.ev2portal.azure.${portalDomain}/#/services/${serviceTreeId}/servicegroups`;
const expectedApiPath =
  `/api/services/${serviceTreeId}/servicegroups`.toLowerCase();

async function collectServiceGroups(headless, timeoutMilliseconds) {
  const context = await chromium.launchPersistentContext(browserProfile, {
    executablePath: edgeExecutable,
    headless,
    viewport: null,
    args: headless ? [] : ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            headless
              ? "EV2 authentication is required."
              : "The EV2 service-group response was not received within 10 minutes.",
          ),
        );
      }, timeoutMilliseconds);

      page.on("response", async (response) => {
        const responseUrl = new URL(response.url());
        if (
          responseUrl.pathname.toLowerCase() !== expectedApiPath ||
          responseUrl.searchParams.get("refresh") !== "false"
        ) {
          return;
        }
        if (!response.ok()) return;

        try {
          const payload = await response.json();
          clearTimeout(timeout);
          resolve(payload);
        } catch {
          clearTimeout(timeout);
          reject(new Error("EV2 returned an unreadable service-group response."));
        }
      });
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    const groups = await responsePromise;
    if (!Array.isArray(groups)) {
      throw new Error("EV2 returned an unexpected service-group response.");
    }
    return groups;
  } finally {
    await context.close();
  }
}

let groups;
try {
  groups = await collectServiceGroups(true, 90_000);
} catch (error) {
  if (
    !(error instanceof Error) ||
    error.message !== "EV2 authentication is required."
  ) {
    throw error;
  }
  console.log("EV2 authentication is required. Opening the Grounds Edge profile.");
  groups = await collectServiceGroups(false, 10 * 60 * 1000);
}

const root = process.cwd();
const observationsPath = path.join(
  root,
  "intelligence",
  "ev2",
  "service-groups.json",
);
await fs.mkdir(path.dirname(observationsPath), { recursive: true });
const observations = await readOperationalJson(observationsPath);
const existingObservation = observations.observations.find(
  (observation) =>
    observation.serviceTreeId.toLowerCase() === serviceTreeId.toLowerCase() &&
    observation.cloud === cloud,
);
const existingGroups = new Map(
  (existingObservation?.serviceGroups ?? []).map((group) => [
    group.serviceGroupId,
    group,
  ]),
);
const observedAt = new Date().toISOString();
const serviceGroups = groups.map((group) => {
  if (
    !group ||
    typeof group.key !== "string" ||
    typeof group.text !== "string"
  ) {
    throw new Error("EV2 returned a service group without a stable key or name.");
  }
  const existing = existingGroups.get(group.key);
  return {
    serviceGroupId: group.key,
    displayName: group.text.replace(/\s+\([^)]*\)\s*$/, "") || group.key,
    sourceUrl: targetUrl,
    infrastructures: Array.isArray(group.infras)
      ? group.infras.filter((infra) => typeof infra === "string")
      : [],
    associations: existing?.associations ?? [],
    deployments: existing?.deployments ?? [],
  };
});
const observation = {
  serviceTreeId,
  cloud,
  portalDomain,
  sourceUrl: targetUrl,
  observedAt,
  completeness: "complete",
  serviceGroups,
};

observations.generatedAt = observedAt;
observations.observations = [
  ...observations.observations.filter(
    (candidate) =>
      candidate.serviceTreeId.toLowerCase() !== serviceTreeId.toLowerCase() ||
      candidate.cloud !== cloud,
  ),
  observation,
];

const schema = JSON.parse(
  await fs.readFile(path.join(root, "ev2_service_groups_schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(observations)) {
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("\n");
  throw new Error(`The normalized EV2 observation is invalid:\n${details}`);
}

const temporaryPath = `${observationsPath}.tmp`;
await fs.writeFile(
  temporaryPath,
  `${JSON.stringify(observations, null, 2)}\n`,
  "utf8",
);
await fs.rename(temporaryPath, observationsPath);
console.log(`Captured ${serviceGroups.length} EV2 service group(s) for ${cloud}.`);
