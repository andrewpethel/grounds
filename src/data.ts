import type { CatalogService, ServiceDomain, ServiceRecord } from "./types";
import type {
  Ev2ServiceGroups,
  SrmObservations,
  TeamsIntelligenceSnapshot,
} from "./types";
import ev2ServiceGroupData from "../intelligence/ev2/service-groups.example.json";
import teamsIntelligenceSnapshot from "../intelligence/teams/deployment-signals.example.json";
import srmObservationData from "../intelligence/srm/release-observations.example.json";
import {
  catalogEntries,
  initialValidation,
} from "virtual:service-catalog";

function getDomain(path: string): ServiceDomain {
  const match = path.match(/services\/([^/]+)\//);
  const domain = match?.[1];

  if (
    domain === "control-plane" ||
    domain === "data-plane" ||
    domain === "alerts-management" ||
    domain === "aiops"
  ) {
    return domain;
  }

  throw new Error(`Unsupported service domain in ${path}`);
}

export const services: CatalogService[] = catalogEntries
  .map(({ record, sourceFilePath, sourcePath }) => ({
    ...record,
    domain: getDomain(sourcePath),
    sourceFilePath,
    sourcePath,
  }))
  .sort((left, right) =>
    left.service.displayName.localeCompare(right.service.displayName),
  );

export const serviceByName = new Map(
  services.map((service) => [service.service.displayName, service]),
);

export const serviceValidationByPath = new Map(
  Object.entries(initialValidation),
);

export const teamsIntelligence =
  teamsIntelligenceSnapshot as TeamsIntelligenceSnapshot;

export const srmObservations = srmObservationData as SrmObservations;

export const ev2ServiceGroups = ev2ServiceGroupData as Ev2ServiceGroups;
