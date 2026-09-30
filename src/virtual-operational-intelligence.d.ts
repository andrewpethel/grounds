declare module "virtual:operational-intelligence" {
  import type {
    Ev2ServiceGroups,
    SrmObservations,
    TeamsIntelligenceSnapshot,
  } from "./types";

  export const ev2ServiceGroupData: Ev2ServiceGroups;
  export const srmObservationData: SrmObservations;
  export const teamsIntelligenceSnapshot: TeamsIntelligenceSnapshot;
}
