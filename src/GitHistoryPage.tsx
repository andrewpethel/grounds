import { useEffect, useMemo, useState } from "react";
import { services } from "./data";
import { readBrowserCache, writeBrowserCache } from "./browserCache";

type GitAssociation = "authored" | "reviewed";

interface GitActivityAuthor {
  displayName: string;
  uniqueName: string;
}

interface GitActivityBase {
  associations: GitAssociation[];
  author: GitActivityAuthor;
  date: string;
  id: string;
  organization: string;
  project: string;
  repository: string;
  serviceNames: string[];
  title: string;
  url: string;
}

interface PullRequestActivity extends GitActivityBase {
  pullRequestId: number;
  sourceBranch: string;
  status: string;
  targetBranch: string;
  type: "pull-request";
}

interface CommitActivity extends GitActivityBase {
  changeCounts: {
    Add?: number;
    Delete?: number;
    Edit?: number;
  };
  sha: string;
  type: "commit";
}

type GitActivity = PullRequestActivity | CommitActivity;

interface GitHistoryError {
  message: string;
  organization: string;
  project: string;
  repository: string;
}

interface GitHistoryResponse {
  activities: GitActivity[];
  days: number;
  errors: GitHistoryError[];
  generatedAt: string;
  identity?: {
    displayName: string;
    uniqueName: string;
  };
  repositoryCount: number;
}

async function readApi<T>(response: Response) {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Grounds Git history request failed.");
  }
  return result;
}

function formatBranch(branch: string) {
  return branch || "unknown branch";
}

function activityKind(activity: GitActivity) {
  return activity.type === "pull-request" ? "Pull request" : "Commit";
}

function serviceDisplayName(serviceName: string) {
  return (
    services.find((service) => service.service.name === serviceName)?.service
      .displayName ?? serviceName
  );
}

export function GitHistoryPage() {
  const initialCache = readBrowserCache<GitHistoryResponse>("git-history:365");
  const [history, setHistory] = useState<GitHistoryResponse | undefined>(
    initialCache?.value,
  );
  const [days, setDays] = useState(365);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [associationFilter, setAssociationFilter] = useState("all");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");

  async function loadHistory(refresh = false) {
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ days: String(days) });
      if (refresh) parameters.set("refresh", "true");
      const response = await fetch(
        `/__grounds/git-history?${parameters.toString()}`,
      );
      const nextHistory = await readApi<GitHistoryResponse>(response);
      setHistory(nextHistory);
      writeBrowserCache(`git-history:${days}`, nextHistory);
    } catch (historyError) {
      setError(
        historyError instanceof Error
          ? historyError.message
          : "Could not load Git history.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = readBrowserCache<GitHistoryResponse>(`git-history:${days}`);
    if (cached) {
      setHistory(cached.value);
      setLoading(false);
      return;
    }
    void loadHistory();
  }, [days]);

  const repositories = useMemo(
    () =>
      [...new Set((history?.activities ?? []).map((item) => item.repository))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [history],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredActivities = useMemo(
    () =>
      (history?.activities ?? []).filter((activity) => {
        if (typeFilter !== "all" && activity.type !== typeFilter) return false;
        if (
          associationFilter !== "all" &&
          !activity.associations.includes(
            associationFilter as GitAssociation,
          )
        ) {
          return false;
        }
        if (
          repositoryFilter !== "all" &&
          activity.repository !== repositoryFilter
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          activity.title,
          activity.repository,
          activity.project,
          activity.organization,
          activity.author.displayName,
          activity.author.uniqueName,
          ...activity.serviceNames.map(serviceDisplayName),
          activity.type === "pull-request"
            ? `${activity.pullRequestId} ${activity.sourceBranch} ${activity.targetBranch}`
            : activity.sha,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [
      associationFilter,
      history,
      normalizedQuery,
      repositoryFilter,
      typeFilter,
    ],
  );

  const pullRequests =
    history?.activities.filter((item) => item.type === "pull-request") ?? [];
  const commits =
    history?.activities.filter((item) => item.type === "commit") ?? [];
  const authoredPullRequests = pullRequests.filter((item) =>
    item.associations.includes("authored"),
  ).length;
  const reviewedPullRequests = pullRequests.filter((item) =>
    item.associations.includes("reviewed"),
  ).length;

  return (
    <main className="content git-history-content">
      <section className="git-history-hero">
        <div>
          <span className="eyebrow">Azure DevOps activity</span>
          <h1>Git history</h1>
          <p>
            Pull requests and commits associated with the signed-in Azure CLI
            identity across repositories enlisted in Grounds.
          </p>
        </div>
        <button
          disabled={loading}
          onClick={() => void loadHistory(true)}
          type="button"
        >
          {loading ? "Loading..." : "Refresh history"}
        </button>
      </section>

      {error && (
        <div className="git-history-error" role="alert">
          <strong>Git history is unavailable.</strong>
          <span>{error}</span>
        </div>
      )}

      {history && (
        <>
          <section className="git-history-summary" aria-label="Git history summary">
            <article>
              <span>Identity</span>
              <strong>{history.identity?.displayName || "Signed-in user"}</strong>
              <small>{history.identity?.uniqueName}</small>
            </article>
            <article>
              <span>Authored PRs</span>
              <strong>{authoredPullRequests}</strong>
              <small>{history.days}-day window</small>
            </article>
            <article>
              <span>Reviewed PRs</span>
              <strong>{reviewedPullRequests}</strong>
              <small>Including completed reviews</small>
            </article>
            <article>
              <span>Commits</span>
              <strong>{commits.length}</strong>
              <small>{history.repositoryCount} catalog repositories</small>
            </article>
          </section>

          <section className="git-history-toolbar" aria-label="Filter Git history">
            <label className="git-history-search">
              <span>Search activity</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles, repositories, branches, or services..."
                type="search"
                value={query}
              />
            </label>
            <label>
              <span>Time range</span>
              <select
                onChange={(event) => setDays(Number(event.target.value))}
                value={days}
              >
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="180">Last 180 days</option>
                <option value="365">Last year</option>
              </select>
            </label>
            <label>
              <span>Activity</span>
              <select
                onChange={(event) => setTypeFilter(event.target.value)}
                value={typeFilter}
              >
                <option value="all">PRs and commits</option>
                <option value="pull-request">Pull requests</option>
                <option value="commit">Commits</option>
              </select>
            </label>
            <label>
              <span>Association</span>
              <select
                onChange={(event) => setAssociationFilter(event.target.value)}
                value={associationFilter}
              >
                <option value="all">Authored or reviewed</option>
                <option value="authored">Authored</option>
                <option value="reviewed">Reviewed</option>
              </select>
            </label>
            <label>
              <span>Repository</span>
              <select
                onChange={(event) => setRepositoryFilter(event.target.value)}
                value={repositoryFilter}
              >
                <option value="all">All repositories</option>
                {repositories.map((repository) => (
                  <option key={repository} value={repository}>
                    {repository}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {history.errors.length > 0 && (
            <details className="git-history-partial">
              <summary>
                Partial results: {history.errors.length} repositories could not
                be queried
              </summary>
              <ul>
                {history.errors.map((historyError) => (
                  <li key={`${historyError.organization}/${historyError.project}/${historyError.repository}`}>
                    <strong>{historyError.repository}</strong>
                    <span>{historyError.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="git-history-results-heading">
            <span>
              {filteredActivities.length} of {history.activities.length} activities
            </span>
            <small>
              Updated{" "}
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(history.generatedAt))}
            </small>
          </div>

          {filteredActivities.length === 0 ? (
            <section className="git-history-empty">
              <strong>No Git activity found</strong>
              <p>
                Adjust the filters or expand the time range. Only Azure DevOps
                repositories enlisted in the Grounds catalog are queried.
              </p>
            </section>
          ) : (
            <section className="git-history-list" aria-label="Git activity">
              {filteredActivities.map((activity) => (
                <article className="git-history-item" key={activity.id}>
                  <div className={`git-history-kind ${activity.type}`}>
                    {activity.type === "pull-request" ? "PR" : "</>"}
                  </div>
                  <div className="git-history-item-body">
                    <div className="git-history-item-heading">
                      <div>
                        <span>
                          {activityKind(activity)} · {activity.repository}
                        </span>
                        <h2>
                          <a href={activity.url} rel="noreferrer" target="_blank">
                            {activity.title}
                          </a>
                        </h2>
                      </div>
                      <time dateTime={activity.date}>
                        {new Intl.DateTimeFormat("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(activity.date))}
                      </time>
                    </div>

                    <div className="git-history-metadata">
                      {activity.associations.map((association) => (
                        <span className={`association ${association}`} key={association}>
                          {association}
                        </span>
                      ))}
                      {activity.type === "pull-request" ? (
                        <>
                          <span className={`status ${activity.status}`}>
                            {activity.status}
                          </span>
                          <span>PR {activity.pullRequestId}</span>
                          <span>
                            {formatBranch(activity.sourceBranch)} →{" "}
                            {formatBranch(activity.targetBranch)}
                          </span>
                        </>
                      ) : (
                        <>
                          <code>{activity.sha.slice(0, 12)}</code>
                          <span>
                            +{activity.changeCounts.Add ?? 0} / ~
                            {activity.changeCounts.Edit ?? 0} / -
                            {activity.changeCounts.Delete ?? 0}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="git-history-services">
                      {activity.serviceNames.map((serviceName) => (
                        <a href={`#/service/${serviceName}`} key={serviceName}>
                          {serviceDisplayName(serviceName)}
                        </a>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}

      {loading && !history && (
        <section className="git-history-loading" aria-busy="true" role="status">
          <strong>Loading authenticated Git activity...</strong>
          <span>
            Grounds is querying the Azure DevOps repositories enlisted in the
            service catalog.
          </span>
        </section>
      )}
    </main>
  );
}
