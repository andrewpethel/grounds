import path from "node:path";
import process from "node:process";
import {
  fetchAuthenticatedJson,
  getAzureCliToken,
} from "./azure-user-auth.mjs";

const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const pipelineFilePattern =
  /(^|\/)(azure-pipelines[^/]*\.ya?ml|\.pipelines\/[^/]+\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/i;

function normalizeRepositoryUrl(value) {
  const url = new URL(String(value ?? "").trim());
  if (url.protocol !== "https:") {
    throw new Error("Repository URL must use HTTPS.");
  }
  url.hash = "";
  url.search = "";
  return url;
}

function decodeSegments(url) {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

export function parseRepositoryUrl(value) {
  const url = normalizeRepositoryUrl(value);
  const segments = decodeSegments(url);

  if (url.hostname.toLocaleLowerCase() === "github.com") {
    if (segments.length < 2) {
      throw new Error("GitHub URL must identify an owner and repository.");
    }
    const owner = segments[0];
    const name = segments[1].replace(/\.git$/i, "");
    return {
      canonicalUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      name,
      organization: owner,
      provider: "github",
    };
  }

  const gitIndex = segments.findIndex(
    (segment) => segment.toLocaleLowerCase() === "_git",
  );
  const isAzureDevOps =
    url.hostname.toLocaleLowerCase() === "dev.azure.com" ||
    url.hostname.toLocaleLowerCase().endsWith(".visualstudio.com");
  if (isAzureDevOps && gitIndex >= 1 && segments[gitIndex + 1]) {
    const organization = url.hostname.toLocaleLowerCase().endsWith(".visualstudio.com")
      ? url.hostname.split(".")[0]
      : segments[0];
    const project = segments[gitIndex - 1];
    const name = segments[gitIndex + 1];
    return {
      canonicalUrl: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
      name,
      organization,
      project,
      provider: "azure-devops",
    };
  }

  throw new Error("Enter an Azure DevOps or GitHub repository URL.");
}

function branchName(value) {
  return String(value ?? "main").replace(/^refs\/heads\//, "") || "main";
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function firstReadmeParagraph(content) {
  if (!content) return "";
  return content
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\r?\n/)
    .map((paragraph) =>
      paragraph
        .replace(/^#+\s+.*$/gm, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((paragraph) => paragraph.length >= 30) ?? "";
}

async function fetchGitHubJson(url) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "Grounds-service-onboarding",
    },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.message ?? `GitHub returned ${response.status}.`);
  }
  return result;
}

async function analyzeGitHub(repository) {
  const owner = encodeURIComponent(repository.organization);
  const name = encodeURIComponent(repository.name);
  const metadata = await fetchGitHubJson(
    `https://api.github.com/repos/${owner}/${name}`,
  );
  const defaultBranch = branchName(metadata.default_branch);
  const warnings = [];
  let pipelineFiles = [];
  let readmeDescription = "";

  try {
    const tree = await fetchGitHubJson(
      `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    );
    pipelineFiles = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob" && pipelineFilePattern.test(entry.path))
      .map((entry) => entry.path)
      .slice(0, 25);
    if (tree.truncated) {
      warnings.push("GitHub truncated the repository tree; some pipeline files may be omitted.");
    }
  } catch (error) {
    warnings.push(`Pipeline discovery was unavailable: ${error.message}`);
  }

  try {
    const readme = await fetchGitHubJson(
      `https://api.github.com/repos/${owner}/${name}/readme`,
    );
    readmeDescription = firstReadmeParagraph(
      Buffer.from(readme.content ?? "", "base64").toString("utf8"),
    );
  } catch {
    warnings.push("README content was unavailable; review the generated description.");
  }

  return {
    ...repository,
    defaultBranch,
    description:
      String(metadata.description ?? "").trim() ||
      readmeDescription ||
      `${repository.name} service repository.`,
    displayName: repository.name.replace(/[-_]+/g, " "),
    pipelineFiles,
    serviceName: slugify(repository.name),
    warnings,
  };
}

async function analyzeAzureDevOps(repository) {
  const token = await getAzureCliToken(azureDevOpsResource);
  const organization = encodeURIComponent(repository.organization);
  const project = encodeURIComponent(repository.project);
  const name = encodeURIComponent(repository.name);
  const metadata = await fetchAuthenticatedJson(
    `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${name}?api-version=7.1`,
    token,
  );
  const defaultBranch = branchName(metadata.defaultBranch);
  const warnings = [];
  let pipelineFiles = [];

  try {
    const definitions = await fetchAuthenticatedJson(
      `https://dev.azure.com/${organization}/${project}/_apis/build/definitions?repositoryId=${encodeURIComponent(metadata.id)}&repositoryType=TfsGit&includeAllProperties=true&api-version=7.1`,
      token,
    );
    pipelineFiles = [...new Set(
      (definitions.value ?? [])
        .map((definition) => definition.process?.yamlFilename)
        .filter(Boolean)
        .map((file) => String(file).replace(/^\/+/, "")),
    )].slice(0, 25);
  } catch (error) {
    warnings.push(`Pipeline discovery was unavailable: ${error.message}`);
  }

  let readmeDescription = "";
  try {
    const readmeUrl = new URL(
      `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${encodeURIComponent(metadata.id)}/items`,
    );
    readmeUrl.searchParams.set("path", "/README.md");
    readmeUrl.searchParams.set("includeContent", "true");
    readmeUrl.searchParams.set("versionDescriptor.version", defaultBranch);
    readmeUrl.searchParams.set("versionDescriptor.versionType", "branch");
    readmeUrl.searchParams.set("api-version", "7.1");
    const readme = await fetch(readmeUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (readme.ok) {
      readmeDescription = firstReadmeParagraph(await readme.text());
    }
  } catch {
    // Repository metadata remains sufficient for a reviewable draft.
  }

  return {
    ...repository,
    defaultBranch,
    description:
      String(metadata.project?.description ?? "").trim() ||
      readmeDescription ||
      `${repository.name} service repository.`,
    displayName: repository.name.replace(/[-_]+/g, " "),
    pipelineFiles,
    serviceName: slugify(repository.name),
    warnings,
  };
}

export async function analyzeRepositoryUrl(value) {
  const repository = parseRepositoryUrl(value);
  return repository.provider === "github"
    ? analyzeGitHub(repository)
    : analyzeAzureDevOps(repository);
}

export function createServiceRecord(payload) {
  const repository = parseRepositoryUrl(payload.repositoryUrl);
  const domain = String(payload.domain ?? "");
  const allowedDomains = new Set([
    "control-plane",
    "data-plane",
    "alerts-management",
    "aiops",
  ]);
  if (!allowedDomains.has(domain)) {
    throw new Error("Select a valid service domain.");
  }

  const serviceName = slugify(payload.serviceName);
  const displayName = String(payload.displayName ?? "").trim();
  const description = String(payload.description ?? "").trim();
  const defaultBranch = String(payload.defaultBranch ?? "").trim();
  if (!serviceName || !displayName || !description || !defaultBranch) {
    throw new Error("Service name, display name, description, and default branch are required.");
  }

  const serviceGroupPatterns = String(payload.serviceGroupPatterns ?? "")
    .split(/[\r\n,]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const pipelineFiles = Array.isArray(payload.pipelineFiles)
    ? payload.pipelineFiles.map(String).filter(Boolean)
    : [];

  return {
    domain,
    fileName: `${serviceName}.json`,
    record: {
      schemaVersion: "1.0.0",
      lastUpdated: new Date().toISOString(),
      service: {
        name: serviceName,
        displayName,
        description,
        serviceType: payload.serviceType ?? "other",
        lifecycle: payload.lifecycle ?? "production",
        ...(String(payload.serviceTreeId ?? "").trim()
          ? { serviceTreeId: String(payload.serviceTreeId).trim() }
          : {}),
        ...(serviceGroupPatterns.length > 0 ? { serviceGroupPatterns } : {}),
        operationalImpactTier: "medium",
      },
      operationalImpact: {
        summary: `Operational impact for ${displayName} requires service-owner review after URL-based onboarding.`,
        customerBlastRadius: "Not yet assessed. Confirm affected customers, APIs, and resource types.",
        dependencyFanOut: "Not yet assessed. Add upstream and downstream dependencies to the catalog record.",
        notificationPathImpact: "Not yet assessed. Confirm whether this service participates in alert evaluation or notification delivery.",
        recoveryUrgency: "Review with the service owner and replace this onboarding assessment with recovery guidance.",
        affectedSystems: [displayName],
      },
      currentVersion: {
        version: "unknown",
        branch: defaultBranch,
      },
      repositories: [
        {
          name: repository.name,
          provider: repository.provider,
          organization: repository.organization,
          ...(repository.project ? { project: repository.project } : {}),
          url: repository.canonicalUrl,
          defaultBranch,
          purpose: "primary-source",
          checkoutStatus: "not-enlisted",
        },
      ],
      pipelines: {
        build: pipelineFiles.map((pipelineFile) => ({
          name: path.basename(pipelineFile),
          provider: pipelineFile.startsWith(".github/workflows/")
            ? "github-actions"
            : "azure-devops",
          url: repository.canonicalUrl,
          pipelineFile,
        })),
        release: [],
      },
      documentation: [],
      trainingMaterials: [],
      knownIssues: [],
      tags: [domain, "remote-onboarding"],
    },
  };
}
