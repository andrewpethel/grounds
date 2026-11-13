import type { Ev2ServiceGroup, Ev2ServiceGroupObservation } from "../src/types";

interface DeploymentService {
  name: string;
  serviceTreeId?: string;
  serviceGroupPatterns?: string[];
  deploymentMatching?: {
    serviceGroupNames?: string[];
    serviceGroupNameContains?: string[];
  };
}
export function deploymentSelectorsMatch(service: DeploymentService, groupName: string): boolean | undefined;
export function resolveDeploymentOwner(services: DeploymentService[], serviceTreeId: string, groupName: string, associations?: string[]): string | undefined;
export function buildSrmServiceGroups(
  services: DeploymentService[],
  service: DeploymentService,
  statuses: Array<{ serviceTreeId: string; serviceGroupName: string }>,
  observations: Ev2ServiceGroupObservation[],
): Array<Ev2ServiceGroup & { enriched: boolean; owner?: string }>;
