import { useEffect, useMemo, useState } from "react";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

interface WorkItem {
  active: boolean;
  areaPath: string;
  assignedTo: {
    displayName: string;
    uniqueName: string;
  };
  changedDate: string;
  id: number;
  iterationPath: string;
  organization: string;
  project: string;
  state: string;
  tags: string[];
  title: string;
  type: string;
  url: string;
}

interface WorkItemsResponse {
  activeCount: number;
  errors: Array<{
    message: string;
    organization: string;
    project: string;
  }>;
  generatedAt: string;
  identity?: {
    displayName: string;
    uniqueName: string;
  };
  projectCount: number;
  workItems: WorkItem[];
}

interface BoardSource {
  label: string;
  projectKey: string;
  team: string;
  url: string;
}

function parseBoardSource(url: string): BoardSource {
  const parsed = new URL(url);
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const organization = parsed.hostname.endsWith(".visualstudio.com")
    ? parsed.hostname.split(".")[0]
    : segments[0];
  const project =
    parsed.hostname === "dev.azure.com" ? segments[1] : segments[0];
  const teamMarker = segments.findIndex(
    (segment, index) =>
      index > segments.indexOf("_boards") && segment.toLowerCase() === "t",
  );
  const team = teamMarker >= 0 ? segments[teamMarker + 1] ?? "" : "";
  if (!organization || !project || !segments.includes("_boards")) {
    throw new Error("Enter a valid Azure DevOps board endpoint.");
  }
  return {
    label: `${organization} / ${project}`,
    projectKey: `${organization}/${project}`,
    team,
    url: parsed.toString(),
  };
}

function initialBoardSources() {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem("grounds-ado-board-sources") ?? "[]",
    ) as BoardSource[];
    const sources = stored.filter(
      (source) => source?.url && source?.projectKey && source?.label,
    );
    return sources;
  } catch {
    return [];
  }
}

async function readApi<T>(response: Response) {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Grounds Work Items request failed.");
  }
  return result;
}

export function WorkItemsPage() {
  const initialBoardUrl = initialBoardSources()[0]?.url ?? "";
  const initialCache = readBrowserCache<WorkItemsResponse>(
    `work-items:${initialBoardUrl}`,
  );
  const [result, setResult] = useState<WorkItemsResponse | undefined>(
    initialCache?.value,
  );
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState("active");
  const [typeFilter, setTypeFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [iterationFilter, setIterationFilter] = useState("all");
  const [boardSources, setBoardSources] =
    useState<BoardSource[]>(initialBoardSources);
  const [selectedBoardUrl, setSelectedBoardUrl] = useState(
    () => initialBoardSources()[0]?.url ?? "",
  );
  const [boardUrl, setBoardUrl] = useState("");

  async function loadWorkItems(
    refresh = false,
    requestedBoardUrl = selectedBoardUrl,
    addBoard = false,
  ) {
    const normalizedBoardUrl = requestedBoardUrl.trim();
    if (!refresh) {
      const cached = readBrowserCache<WorkItemsResponse>(
        `work-items:${normalizedBoardUrl}`,
      );
      if (cached) {
        setResult(cached.value);
        setSelectedBoardUrl(normalizedBoardUrl);
        if (addBoard && normalizedBoardUrl) {
          const source = parseBoardSource(normalizedBoardUrl);
          setBoardSources((current) =>
            current.some((item) => item.url === source.url)
              ? current
              : [...current, source],
          );
        }
        setProjectFilter("all");
        setAreaFilter("all");
        setIterationFilter("all");
        setError("");
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams();
      if (refresh) parameters.set("refresh", "true");
      if (normalizedBoardUrl) {
        parameters.set("boardUrl", normalizedBoardUrl);
      }
      const response = await fetch(
        `/__grounds/ado-work-items?${parameters.toString()}`,
      );
      const nextResult = await readApi<WorkItemsResponse>(response);
      setResult(nextResult);
      writeBrowserCache(
        `work-items:${normalizedBoardUrl}`,
        nextResult,
      );
      if (normalizedBoardUrl) {
        const source = parseBoardSource(normalizedBoardUrl);
        setSelectedBoardUrl(source.url);
        if (addBoard) {
          setBoardSources((current) =>
            current.some((item) => item.url === source.url)
              ? current
              : [...current, source],
          );
        }
      } else {
        setSelectedBoardUrl("");
      }
      setProjectFilter("all");
      setAreaFilter("all");
      setIterationFilter("all");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load assigned work items.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialCache) void loadWorkItems(false, selectedBoardUrl);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "grounds-ado-board-sources",
      JSON.stringify(boardSources),
    );
  }, [boardSources]);

  const types = useMemo(
    () =>
      [...new Set((result?.workItems ?? []).map((item) => item.type))].sort(),
    [result],
  );
  const projects = useMemo(
    () =>
      [
        ...new Set(
          (result?.workItems ?? []).map(
            (item) => `${item.organization}/${item.project}`,
          ),
        ),
      ].sort(),
    [result],
  );
  const areaPaths = useMemo(
    () =>
      [
        ...new Set(
          (result?.workItems ?? [])
            .map((item) => item.areaPath)
            .filter(Boolean),
        ),
      ].sort(),
    [result],
  );
  const iterationPaths = useMemo(
    () =>
      [
        ...new Set(
          (result?.workItems ?? [])
            .map((item) => item.iterationPath)
            .filter(Boolean),
        ),
      ].sort(),
    [result],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = useMemo(
    () =>
      (result?.workItems ?? []).filter((item) => {
        if (activityFilter === "active" && !item.active) return false;
        if (activityFilter === "completed" && item.active) return false;
        if (typeFilter !== "all" && item.type !== typeFilter) return false;
        if (
          projectFilter !== "all" &&
          `${item.organization}/${item.project}` !== projectFilter
        ) {
          return false;
        }
        if (areaFilter !== "all" && item.areaPath !== areaFilter) return false;
        if (
          iterationFilter !== "all" &&
          item.iterationPath !== iterationFilter
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          item.id,
          item.title,
          item.type,
          item.state,
          item.project,
          item.areaPath,
          item.iterationPath,
          ...item.tags,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [
      activityFilter,
      areaFilter,
      iterationFilter,
      normalizedQuery,
      projectFilter,
      result,
      typeFilter,
    ],
  );
  const recentlyChanged =
    result?.workItems.filter(
      (item) =>
        Date.now() - Date.parse(item.changedDate) <= 90 * 24 * 60 * 60 * 1000,
    ).length ?? 0;

  return (
    <main className="content work-items-content">
      <section className="work-items-hero">
        <div>
          <span className="eyebrow">Azure DevOps ownership</span>
          <h1>Work items</h1>
          <p>
            User stories, tasks, bugs, and features assigned to the signed-in
            Azure CLI identity across projects enlisted through Grounds
            repositories.
          </p>
        </div>
        <button
          disabled={loading}
          onClick={() => void loadWorkItems(true)}
          type="button"
        >
          {loading ? "Loading..." : "Refresh work items"}
        </button>
      </section>

      {error && (
        <div className="work-items-error" role="alert">
          <strong>Work items are unavailable.</strong>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <>
          <section className="work-items-summary" aria-label="Work items summary">
            <article>
              <span>Identity</span>
              <strong>{result.identity?.displayName || "Signed-in user"}</strong>
              <small>{result.identity?.uniqueName}</small>
            </article>
            <article>
              <span>Active assigned</span>
              <strong>{result.activeCount}</strong>
              <small>Excludes done, closed, resolved, and removed</small>
            </article>
            <article>
              <span>Assigned history</span>
              <strong>{result.workItems.length}</strong>
              <small>{result.projectCount} configured projects</small>
            </article>
            <article>
              <span>Changed recently</span>
              <strong>{recentlyChanged}</strong>
              <small>Within the last 90 days</small>
            </article>
          </section>

          <section className="work-items-board-source">
            <label>
              <span>Additional board endpoint</span>
              <input
                onChange={(event) => setBoardUrl(event.target.value)}
                placeholder="https://dev.azure.com/org/project/_boards/..."
                type="url"
                value={boardUrl}
              />
            </label>
            <button
              disabled={loading}
              onClick={() => void loadWorkItems(true, boardUrl, true)}
              type="button"
            >
              Add and load board
            </button>
            <small>
              Adds the board&apos;s project to repository-derived project scopes
              using your Azure CLI identity.
            </small>
            <div className="work-items-board-chips" aria-label="Work item sources">
              <button
                className={selectedBoardUrl ? "" : "active"}
                disabled={loading}
                onClick={() => void loadWorkItems(false, "")}
                type="button"
              >
                Catalog projects
              </button>
              {boardSources.map((source) => (
                <button
                  className={selectedBoardUrl === source.url ? "active" : ""}
                  disabled={loading}
                  key={source.url}
                  onClick={() => void loadWorkItems(false, source.url)}
                  title={source.team || source.url}
                  type="button"
                >
                  {source.label}
                  {source.team && <small>{source.team}</small>}
                </button>
              ))}
            </div>
          </section>

          <section className="work-items-toolbar" aria-label="Filter work items">
            <label className="work-items-search">
              <span>Search work</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, ID, area, iteration, or tag..."
                type="search"
                value={query}
              />
            </label>
            <label>
              <span>Activity</span>
              <select
                onChange={(event) => setActivityFilter(event.target.value)}
                value={activityFilter}
              >
                <option value="active">Active assigned</option>
                <option value="all">All assigned history</option>
                <option value="completed">Completed history</option>
              </select>
            </label>
            <label>
              <span>Type</span>
              <select
                onChange={(event) => setTypeFilter(event.target.value)}
                value={typeFilter}
              >
                <option value="all">All types</option>
                {types.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Project</span>
              <select
                onChange={(event) => setProjectFilter(event.target.value)}
                value={projectFilter}
              >
                <option value="all">All projects</option>
                {projects.map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Area Path</span>
              <select
                onChange={(event) => setAreaFilter(event.target.value)}
                value={areaFilter}
              >
                <option value="all">All Area Paths</option>
                {areaPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Iteration Path</span>
              <select
                onChange={(event) => setIterationFilter(event.target.value)}
                value={iterationFilter}
              >
                <option value="all">All Iteration Paths</option>
                {iterationPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {result.errors.length > 0 && (
            <details className="work-items-partial">
              <summary>
                Partial results: {result.errors.length} projects could not be
                queried
              </summary>
              {result.errors.map((item) => (
                <p key={`${item.organization}/${item.project}`}>
                  <strong>
                    {item.organization}/{item.project}
                  </strong>{" "}
                  {item.message}
                </p>
              ))}
            </details>
          )}

          <div className="work-items-results-heading">
            <span>
              {filteredItems.length} of {result.workItems.length} work items
            </span>
            <small>
              Updated{" "}
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(result.generatedAt))}
            </small>
          </div>

          {filteredItems.length === 0 ? (
            <section className="work-items-empty">
              <strong>
                {activityFilter === "active"
                  ? "No active work is assigned"
                  : "No work items match"}
              </strong>
              <p>
                {activityFilter === "active"
                  ? "The signed-in identity has no non-completed assignments in configured projects. Choose All assigned history to inspect prior work."
                  : "Adjust the search or filters to broaden the result set."}
              </p>
            </section>
          ) : (
            <section className="work-items-list" aria-label="Assigned work items">
              {filteredItems.map((item) => (
                <article className="work-item-card" key={`${item.organization}/${item.project}/${item.id}`}>
                  <div className="work-item-id">
                    <span>{item.type}</span>
                    <strong>#{item.id}</strong>
                  </div>
                  <div className="work-item-body">
                    <header>
                      <div>
                        <span>
                          {item.organization}/{item.project}
                        </span>
                        <h2>
                          <a href={item.url} rel="noreferrer" target="_blank">
                            {item.title}
                          </a>
                        </h2>
                      </div>
                      <time dateTime={item.changedDate}>
                        {new Intl.DateTimeFormat("en-US", {
                          dateStyle: "medium",
                        }).format(new Date(item.changedDate))}
                      </time>
                    </header>
                    <div className="work-item-metadata">
                      <span className={item.active ? "active" : "completed"}>
                        {item.state}
                      </span>
                      {item.areaPath && <span>Area: {item.areaPath}</span>}
                      {item.iterationPath && (
                        <span>Iteration: {item.iterationPath}</span>
                      )}
                    </div>
                    {item.tags.length > 0 && (
                      <div className="work-item-tags">
                        {item.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}

      {loading && !result && (
        <section className="work-items-loading" aria-busy="true" role="status">
          <strong>Loading authenticated Azure DevOps work...</strong>
          <span>
            Grounds is querying the projects discovered from catalog
            repositories.
          </span>
        </section>
      )}
    </main>
  );
}
