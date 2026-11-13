export function deploymentSelectorsMatch(service, groupName) {
  const matching = service.deploymentMatching;
  const exact = matching?.serviceGroupNames;
  const contains = matching?.serviceGroupNameContains ?? (!matching ? service.serviceGroupPatterns : undefined);
  if (!exact?.length && !contains?.length) return undefined;
  const normalized = groupName.toLowerCase();
  return (!exact?.length || exact.some((name) => normalized === name.toLowerCase())) &&
    (!contains?.length || contains.some((part) => normalized.includes(part.toLowerCase())));
}

export function resolveDeploymentOwner(services, serviceTreeId, groupName, associations = []) {
  const candidates = services.filter((service) =>
    service.serviceTreeId?.toLowerCase() === serviceTreeId.toLowerCase() &&
    deploymentSelectorsMatch(service, groupName) !== false);
  const explicit = candidates.filter((service) => associations.includes(service.name));
  if (explicit.length) return explicit.length === 1 ? explicit[0].name : undefined;
  const matched = candidates.filter((service) => deploymentSelectorsMatch(service, groupName) === true);
  return matched.length === 1 ? matched[0].name : undefined;
}

export function buildSrmServiceGroups(services, service, statuses, observations) {
  if (!service.serviceTreeId) return [];
  const tree = service.serviceTreeId.toLowerCase();
  const metadata = new Map(
    observations
      .filter((observation) =>
        observation.cloud === "public" &&
        observation.serviceTreeId.toLowerCase() === tree)
      .flatMap((observation) => observation.serviceGroups)
      .map((group) => [group.serviceGroupId, group]),
  );
  const groups = new Map();
  for (const status of statuses) {
    const id = status.serviceGroupName;
    if (status.serviceTreeId.toLowerCase() !== tree ||
      deploymentSelectorsMatch(service, id) === false || groups.has(id)) continue;
    const enrichment = metadata.get(id);
    const owner = resolveDeploymentOwner(
      services, status.serviceTreeId, id,
      enrichment?.associations.map((association) => association.serviceName),
    );
    if (owner && owner !== service.name) continue;
    groups.set(id, {
      serviceGroupId: id,
      displayName: enrichment?.displayName ?? id,
      sourceUrl: enrichment?.sourceUrl ?? "https://srm.azure.com/#/",
      infrastructures: enrichment?.infrastructures ?? [],
      associations: enrichment?.associations ?? [],
      deployments: enrichment?.deployments ?? [],
      enriched: Boolean(enrichment),
      owner,
    });
  }
  return [...groups.values()].sort((left, right) =>
    Number(Boolean(right.owner)) - Number(Boolean(left.owner)) ||
    left.displayName.localeCompare(right.displayName));
}
