import type { CatalogService, ServiceDomain, ServiceRecord } from "./types";
import type { DesktopSnapshot } from "./desktop";
import type {
  Ev2ServiceGroups,
  SrmObservations,
  TeamsIntelligenceSnapshot,
} from "./types";
import {
  ev2ServiceGroupData,
  srmObservationData,
  teamsIntelligenceSnapshot,
} from "virtual:operational-intelligence";
import {
  catalogEntries,
  initialValidation,
} from "virtual:service-catalog";

function getDomain(record: ServiceRecord): ServiceDomain {
  return `domain:${record.service.domain?.trim() || record.service.displayName}`;
}

export function domainLabel(domain: ServiceDomain) {
  return domain.slice("domain:".length);
}

export function getServiceDomains() {
  return [...new Set(services.map((service) => service.domain))]
    .sort((left, right) => domainLabel(left).localeCompare(domainLabel(right)));
}

export const services: CatalogService[] = catalogEntries
  .map(({ record, sourceFilePath, sourcePath }) => ({
    ...record,
    domain: getDomain(record),
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
export const manifestPipelineErrors = new Map<string, string>();

export const teamsIntelligence =
  teamsIntelligenceSnapshot as TeamsIntelligenceSnapshot;

export const srmObservations = srmObservationData as SrmObservations;

export const ev2ServiceGroups = ev2ServiceGroupData as Ev2ServiceGroups;

export function initializeDesktopData(snapshot: DesktopSnapshot) {
  manifestPipelineErrors.clear();
  Object.entries(snapshot.manifestPipelineErrors ?? {}).forEach(([key, value]) => manifestPipelineErrors.set(key, value));
  services.splice(0, services.length, ...snapshot.catalogEntries.map(({ record, sourceFilePath, sourcePath }) => ({
    ...record, domain: getDomain(record), sourceFilePath, sourcePath,
  })).sort((left, right) => left.service.displayName.localeCompare(right.service.displayName)));
  serviceByName.clear();
  services.forEach((service) => serviceByName.set(service.service.displayName, service));
  serviceValidationByPath.clear();
  Object.entries(snapshot.initialValidation).forEach(([key, value]) => serviceValidationByPath.set(key, value));
  Object.assign(ev2ServiceGroups, snapshot.ev2ServiceGroupData);
  Object.assign(srmObservations, snapshot.srmObservationData);
  Object.assign(teamsIntelligence, snapshot.teamsIntelligenceSnapshot);
}
