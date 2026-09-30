import { useEffect, useMemo, useState } from "react";
import { services } from "./data";
import { vscodeFileUri } from "./links";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

type RepositoryStatus = "ahead" | "behind" | "current" | "error" | "not-enlisted";

interface LocalRepository {
  ahead?: number;
  behind?: number;
  branch?: string;
  checkedAt?: string;
  defaultBranch: string;
  dirty?: boolean;
  error?: string;
  lastCommit?: string;
  localPath: string;
  name: string;
  remoteUrl: string;
  serviceNames: string[];
  status: RepositoryStatus;
}

function summarizeRepositories(repositories: LocalRepository[]) {
  return {
    behind: repositories.filter((item) => item.status === "behind").length,
    current: repositories.filter((item) => item.status === "current").length,
    errors: repositories.filter((item) => item.status === "error").length,
    notEnlisted: repositories.filter((item) => item.status === "not-enlisted")
      .length,
    total: repositories.length,
  };
}

interface LocalReposResponse {
  generatedAt: string;
  repositories: LocalRepository[];
  summary: {
    behind: number;
    current: number;
    errors: number;
    notEnlisted: number;
    total: number;
  };
}

function serviceLabel(name: string) {
  return (
    services.find((service) => service.service.name === name)?.service
      .displayName ?? name
  );
}

export function LocalReposPage() {
  const cachedResult = readBrowserCache<LocalReposResponse>("local-repos");
  const [result, setResult] = useState<LocalReposResponse | undefined>(
    cachedResult?.value,
  );
  const [loading, setLoading] = useState(!cachedResult);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | RepositoryStatus>("all");
  const [query, setQuery] = useState("");
  const [refreshingRepository, setRefreshingRepository] = useState("");

  async function loadRepositories(refresh = false) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/__grounds/local-repos${refresh ? "?refresh=true" : ""}`,
      );
      const payload = (await response.json()) as LocalReposResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Local repository status is unavailable.");
      }
      setResult(payload);
      writeBrowserCache("local-repos", payload);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Local repository status is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!cachedResult) void loadRepositories();
  }, []);

  async function refreshRepository(repository: LocalRepository) {
    setRefreshingRepository(repository.localPath);
    setError("");
    try {
      const parameters = new URLSearchParams({
        localPath: repository.localPath,
        refresh: "true",
      });
      const response = await fetch(`/__grounds/local-repos?${parameters}`);
      const payload = (await response.json()) as {
        error?: string;
        generatedAt: string;
        repository: LocalRepository;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Could not refresh ${repository.name}.`);
      }
      setResult((current) => {
        if (!current) return current;
        const repositories = current.repositories.map((item) =>
          item.localPath === payload.repository.localPath
            ? payload.repository
            : item,
        );
        return {
          generatedAt: payload.generatedAt,
          repositories,
          summary: summarizeRepositories(repositories),
        };
      });
      const cached = readBrowserCache<LocalReposResponse>("local-repos");
      if (cached) {
        const repositories = cached.value.repositories.map((item) =>
          item.localPath === payload.repository.localPath
            ? payload.repository
            : item,
        );
        writeBrowserCache("local-repos", {
          generatedAt: payload.generatedAt,
          repositories,
          summary: summarizeRepositories(repositories),
        });
      }
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : `Could not refresh ${repository.name}.`,
      );
    } finally {
      setRefreshingRepository("");
    }
  }

  const visibleRepositories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (result?.repositories ?? []).filter((repository) => {
      if (filter !== "all" && repository.status !== filter) return false;
      return (
        !normalizedQuery ||
        repository.name.toLocaleLowerCase().includes(normalizedQuery) ||
        repository.localPath.toLocaleLowerCase().includes(normalizedQuery) ||
        repository.serviceNames.some((name) =>
          serviceLabel(name).toLocaleLowerCase().includes(normalizedQuery),
        )
      );
    });
  }, [filter, query, result]);

  return (
    <main className="content local-repos-content">
      <section className="local-repos-hero">
        <div>
          <span className="eyebrow">Working copy health</span>
          <h1>Local repos</h1>
          <p>
            Compares each enlisted repository with its latest remote main or
            master branch so you know which working copies need a pull.
          </p>
        </div>
        <button disabled={loading} onClick={() => void loadRepositories(true)}>
          {loading ? "Checking remotes..." : "Refresh repos"}
        </button>
      </section>

      {error && <div className="local-repos-error" role="alert">{error}</div>}

      {result && (
        <>
          <section className="local-repos-summary">
            <article className={result.summary.behind ? "attention" : ""}>
              <span>Need pull</span>
              <strong>{result.summary.behind}</strong>
              <small>Behind remote default branch</small>
            </article>
            <article>
              <span>Current</span>
              <strong>{result.summary.current}</strong>
              <small>At remote head</small>
            </article>
            <article>
              <span>Not enlisted</span>
              <strong>{result.summary.notEnlisted}</strong>
              <small>Configured path is missing</small>
            </article>
            <article>
              <span>Checked</span>
              <strong>{result.summary.total}</strong>
              <small>{result.summary.errors} checks failed</small>
            </article>
          </section>

          <section className="local-repos-toolbar">
            <label>
              <span>Search repositories</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Repository, path, or service..."
                type="search"
                value={query}
              />
            </label>
            <label>
              <span>Status</span>
              <select
                onChange={(event) =>
                  setFilter(event.target.value as "all" | RepositoryStatus)
                }
                value={filter}
              >
                <option value="all">All repositories</option>
                <option value="behind">Need pull</option>
                <option value="current">Current</option>
                <option value="ahead">Ahead locally</option>
                <option value="not-enlisted">Not enlisted</option>
                <option value="error">Check failed</option>
              </select>
            </label>
          </section>

          <div className="local-repos-results-heading">
            <span>{visibleRepositories.length} repositories</span>
            <small>
              Updated {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(result.generatedAt))}
            </small>
          </div>

          <section className="local-repos-list">
            {visibleRepositories.map((repository) => (
              <article className={`local-repo-card ${repository.status}`} key={repository.localPath}>
                <div className="local-repo-heading">
                  <div>
                    <span className={`local-repo-status ${repository.status}`}>
                      {repository.status === "behind"
                        ? `Pull ${repository.behind} commit${repository.behind === 1 ? "" : "s"}`
                        : repository.status === "current"
                          ? "Current"
                          : repository.status === "ahead"
                            ? `${repository.ahead} ahead`
                            : repository.status === "not-enlisted"
                              ? "Not enlisted"
                              : "Check failed"}
                    </span>
                    <h2>{repository.name}</h2>
                  </div>
                  <div className="local-repo-actions">
                    <button
                      disabled={refreshingRepository === repository.localPath}
                      onClick={() => void refreshRepository(repository)}
                      type="button"
                    >
                      {refreshingRepository === repository.localPath
                        ? "Checking..."
                        : `Refresh ${repository.defaultBranch}`}
                    </button>
                    {repository.status !== "not-enlisted" && (
                      <a
                        href={vscodeFileUri(repository.localPath)}
                        title={`Open ${repository.name} in Visual Studio Code`}
                      >
                        Open in VS Code
                      </a>
                    )}
                    {repository.remoteUrl && (
                      <a href={repository.remoteUrl} rel="noreferrer" target="_blank">
                        Open remote
                      </a>
                    )}
                  </div>
                </div>
                <dl>
                  <div><dt>Local branch</dt><dd>{repository.branch || "Unavailable"}</dd></div>
                  <div><dt>Compared with</dt><dd>origin/{repository.defaultBranch}</dd></div>
                  <div><dt>Working tree</dt><dd>{repository.dirty ? "Has local changes" : "Clean"}{repository.checkedAt ? ` · checked ${new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(repository.checkedAt))}` : ""}</dd></div>
                  <div><dt>Local path</dt><dd><code>{repository.localPath}</code></dd></div>
                </dl>
                {repository.error && <p className="local-repo-error">{repository.error}</p>}
                <div className="local-repo-services">
                  {repository.serviceNames.map((name) => (
                    <a href={`#/service/${name}`} key={name}>{serviceLabel(name)}</a>
                  ))}
                </div>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
