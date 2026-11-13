import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { srmObservations } from "./data";
import type {
  CatalogService,
  ServiceChatMessage,
  ServiceChatSession,
  ServiceChatSource,
} from "./types";

interface ChatContext {
  environment: string;
  releaseId: string;
}

interface CopilotStatus {
  authenticated: boolean;
  signingIn: boolean;
  busy: boolean;
  reconnectRequired?: boolean;
  restartRequired?: boolean;
  operatorId?: string;
  login?: string;
  host?: string;
  loginUrl?: string;
  choices?: { selectionId: string; login: string; host: string }[];
  error?: string;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? "Service chat request failed.");
  }
  return result as T;
}

function InlineContent({
  children,
  sources,
}: {
  children: string;
  sources: ServiceChatSource[];
}) {
  const parts = children.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        const citation = part.match(/^\[(\d+)]$/);
        if (citation) {
          const source = sources.find((item) => item.id === Number(citation[1]));
          return source ? (
            <a
              className="chat-citation"
              href={`#chat-source-${source.id}`}
              onClick={(event) => {
                event.preventDefault();
                const target = event.currentTarget.closest("article")?.querySelector<HTMLElement>(`#chat-source-${source.id}`);
                const details = target?.closest("details");
                if (details) details.open = true;
                target?.scrollIntoView({ behavior: "smooth", block: "center" });
                target?.focus({ preventScroll: true });
              }}
              key={index}
              title={source.title}
            >
              {source.id}
            </a>
          ) : (
            <Fragment key={index}>{part}</Fragment>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function AssistantContent({ message }: { message: ServiceChatMessage }) {
  const blocks: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let listType: "ordered" | "unordered" | undefined;

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      listType === "ordered" ? (
        <ol key={`list-${blocks.length}`}>{listItems}</ol>
      ) : (
        <ul key={`list-${blocks.length}`}>{listItems}</ul>
      ),
    );
    listItems = [];
    listType = undefined;
  }

  for (const rawLine of message.content.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h3 key={`heading-${blocks.length}`}>{line.slice(3)}</h3>);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listType && listType !== "ordered") flushList();
      listType = "ordered";
      listItems.push(
        <li key={`item-${blocks.length}-${listItems.length}`}>
          <InlineContent sources={message.sources}>{ordered[1]}</InlineContent>
        </li>,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      if (listType && listType !== "unordered") flushList();
      listType = "unordered";
      listItems.push(
        <li key={`item-${blocks.length}-${listItems.length}`}>
          <InlineContent sources={message.sources}>{line.slice(2)}</InlineContent>
        </li>,
      );
      continue;
    }
    flushList();
    blocks.push(
      <p key={`paragraph-${blocks.length}`}>
        <InlineContent sources={message.sources}>{line}</InlineContent>
      </p>,
    );
  }
  flushList();
  return <div className="service-chat-answer">{blocks}</div>;
}

function SourceCard({ source }: { source: ServiceChatSource }) {
  const content = (
    <>
      <span>{source.id}</span>
      <div>
        <strong>{source.title}</strong>
        <small>{source.type.replaceAll("-", " ")}</small>
      </div>
    </>
  );
  if (source.type === "architecture" && /^#\/service\/[a-z0-9]+(?:-[a-z0-9]+)*\/flow$/.test(source.location)) {
    return <a href={source.location} id={`chat-source-${source.id}`}>{content}</a>;
  }
  return /^https?:\/\//.test(source.location) ? (
    <a
      href={source.location}
      id={`chat-source-${source.id}`}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <div id={`chat-source-${source.id}`} tabIndex={-1}>{content}</div>
  );
}

function ChatMessage({ message }: { message: ServiceChatMessage }) {
  return (
    <article className={`service-chat-message ${message.role}`}>
      <header>
        <strong>{message.role === "assistant" ? "Grounds" : "You"}</strong>
        <time dateTime={message.createdAt}>
          {new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(message.createdAt))}
        </time>
      </header>
      {message.role === "assistant" ? (
        <AssistantContent message={message} />
      ) : (
        <p>{message.content}</p>
      )}
      {message.sources.length > 0 && (
        <details className="service-chat-sources">
          <summary>{message.sources.length} evidence sources</summary>
          <div>
            {message.sources.map((source) => (
              <SourceCard key={source.id} source={source} />
            ))}
          </div>
        </details>
      )}
      {message.provider && <small className="chat-provider">{message.provider}</small>}
    </article>
  );
}

export function ServiceChatPage({
  onBack,
  onFlow,
  service,
}: {
  onBack: () => void;
  onFlow: () => void;
  service: CatalogService;
}) {
  const [sessions, setSessions] = useState<ServiceChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [messages, setMessages] = useState<ServiceChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState<ChatContext>({
    environment: "",
    releaseId: "",
  });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<CopilotStatus>({
    authenticated: false, signingIn: false, busy: false,
  });
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const connectionVersionRef = useRef(0);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const releases = useMemo(
    () =>
      srmObservations.releases
        .filter((release) => release.serviceName === service.service.name)
        .sort(
          (left, right) =>
            new Date(right.updatedOn ?? right.observedAt).valueOf() -
            new Date(left.updatedOn ?? left.observedAt).valueOf(),
        ),
    [service.service.name],
  );

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const version = connectionVersionRef.current;
      try {
        const next = await requestJson<CopilotStatus>("/__grounds/service-chat/copilot/status");
        if (active && version === connectionVersionRef.current) setConnection(next);
      } catch (nextError) {
        if (active && version === connectionVersionRef.current) {
          setConnection((current) => ({ ...current, authenticated: false, signingIn: false, busy: false }));
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (active) {
          setCheckingConnection(false);
          timer = setTimeout(() => void refresh(), 3000);
        }
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  async function changeConnection(action: "login" | "cancel" | "logout", selectionId?: string) {
    connectionVersionRef.current++;
    setConnectionBusy(true);
    setError("");
    try {
      const result = await requestJson<CopilotStatus>(`/__grounds/service-chat/copilot/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectionId ? { selectionId } : {}),
      });
      connectionVersionRef.current++;
      setConnection(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setConnectionBusy(false);
    }
  }

  useEffect(() => {
    setSessions([]);
    setSelectedSessionId(undefined);
    setMessages([]);
    setQuestion("");
    setContext({ environment: "", releaseId: "" });
  }, [service.service.name, connection.operatorId]);

  useEffect(() => {
    if (!connection.authenticated || !connection.operatorId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    requestJson<{ sessions: ServiceChatSession[] }>(
      `/__grounds/service-chat/sessions?serviceName=${encodeURIComponent(service.service.name)}`,
    )
      .then((result) => {
        if (!active) return;
        setSessions(result.sessions);
        setSelectedSessionId((current) =>
          result.sessions.some((session) => session.id === current) ? current : result.sessions[0]?.id);
      })
      .catch((nextError) => {
        if (active) setError(nextError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [service.service.name, connection.operatorId, connection.authenticated]);

  useEffect(() => {
    if (sending || !connection.authenticated) return;
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }
    let active = true;
    setLoading(true);
    requestJson<{ messages: ServiceChatMessage[] }>(
      `/__grounds/service-chat/sessions/${encodeURIComponent(selectedSessionId)}/messages`,
    )
      .then((result) => {
        if (active) {
          setMessages(result.messages);
          const previous = [...result.messages].reverse().find((message) => message.role === "user");
          if (!question.trim()) {
            setContext({
              environment: previous?.context?.environment ?? "",
              releaseId: previous?.context?.releaseId ?? "",
            });
          }
        }
      })
      .catch((nextError) => {
        if (active) setError(nextError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSessionId, connection.operatorId, connection.authenticated, sending]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function createSession() {
    const result = await requestJson<{ session: ServiceChatSession }>(
      "/__grounds/service-chat/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName: service.service.name }),
      },
    );
    setSessions((current) => [result.session, ...current]);
    setSelectedSessionId(result.session.id);
    setMessages([]);
    return result.session;
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || sending || loading || connectionBusy || !connection.authenticated || selectedSession?.readOnly) return;
    setSending(true);
    setError("");
    try {
      const session =
        sessions.find((item) => item.id === selectedSessionId) ??
        (await createSession());
      const result = await requestJson<{
        assistantMessage: ServiceChatMessage;
        session: ServiceChatSession;
        userMessage: ServiceChatMessage;
      }>(
        `/__grounds/service-chat/sessions/${encodeURIComponent(session.id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: nextQuestion,
            context: {
              environment: context.environment || undefined,
              releaseId: context.releaseId || undefined,
            },
          }),
        },
      );
      setMessages((current) => [
        ...current,
        result.userMessage,
        result.assistantMessage,
      ]);
      setQuestion("");
      setSessions((current) => [
        result.session,
        ...current.filter((item) => item.id !== result.session.id),
      ]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      const version = ++connectionVersionRef.current;
      try {
        const next = await requestJson<CopilotStatus>("/__grounds/service-chat/copilot/status");
        if (version === connectionVersionRef.current) setConnection(next);
      } catch (connectionError) {
        if (version === connectionVersionRef.current) {
          setConnection((current) => ({ ...current, authenticated: false }));
          setError(`${nextError instanceof Error ? nextError.message : String(nextError)} Connection check failed: ${
            connectionError instanceof Error ? connectionError.message : String(connectionError)}`);
        }
      }
    } finally {
      setSending(false);
    }
  }

  async function deleteSession(sessionId: string) {
    await requestJson(
      `/__grounds/service-chat/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    const remaining = sessions.filter((session) => session.id !== sessionId);
    setSessions(remaining);
    setSelectedSessionId(remaining[0]?.id);
  }

  const starterQuestions = [
    "What should I inspect first when a deployment causes a regional health monitor to go unhealthy?",
    "Show me the latest failed deployment evidence and likely dependency checks.",
    "Where are this service's monitor definitions, telemetry, and operational runbooks?",
  ];

  return (
    <main className="service-chat-page">
      <header className="service-chat-header">
        <div>
          <button className="back-button" onClick={onBack} type="button">
            <span aria-hidden="true">‹</span>
            Back to service
          </button>
          <span className="eyebrow">Grounded troubleshooting</span>
          <h1>{service.service.displayName}</h1>
          <p>
            Ask about deployments, monitors, code, telemetry, dependencies, and
            operational evidence. Answers cite the sources Grounds used.
          </p>
          <button className="back-button" onClick={onFlow} type="button">
            Architecture flow
          </button>
        </div>
        <span className="service-chat-provider-status" data-connected={connection.authenticated}>
          <span />
          {connection.authenticated ? `GitHub Copilot · ${connection.login}` : "GitHub Copilot not connected"}
        </span>
      </header>

      <section className="service-chat-connection" aria-label="AI connection">
        <div>
          <strong>{connection.authenticated ? `Connected as ${connection.login}` : connection.reconnectRequired ? "Reconnect your GitHub Copilot account" : "Connect your GitHub Copilot account"}</strong>
          <p>
            Questions, recent conversation history, and selected service/code evidence are sent to GitHub Copilot.
            Use an organization-approved account. Grounds never asks for your password or token.
          </p>
          {connection.signingIn && <p>Complete sign-in in your browser. Secure storage is required; plaintext token storage is refused.</p>}
          {connection.loginUrl && (
            <a href={connection.loginUrl} rel="noreferrer" target="_blank">Open GitHub sign-in</a>
          )}
          {connection.choices?.map((choice) => (
            <button disabled={connectionBusy} key={choice.selectionId}
              onClick={() => void changeConnection("login", choice.selectionId)} type="button">
              Use {choice.login} ({choice.host})
            </button>
          ))}
          {connection.error && <p role="alert">{connection.error}</p>}
        </div>
        {connection.signingIn ? (
          <button disabled={connectionBusy} onClick={() => void changeConnection("cancel")} type="button">Cancel sign-in</button>
        ) : (
          <button disabled={connectionBusy || checkingConnection || sending || connection.busy || connection.restartRequired}
            onClick={() => void changeConnection(connection.authenticated ? "logout" : "login")} type="button">
            {connectionBusy || checkingConnection ? "Checking connection..." : connection.restartRequired ? "Restart Grounds to reconnect" : connection.authenticated ? "Sign out of Copilot" : connection.reconnectRequired ? "Reconnect GitHub Copilot" : "Connect GitHub Copilot"}
          </button>
        )}
      </section>

      <div className="service-chat-layout">
        <aside className="service-chat-sessions">
          <button
            className="new-chat-button"
            disabled={!connection.authenticated || sending || connectionBusy}
            onClick={() => void createSession().catch((nextError: Error) => setError(nextError.message))}
            type="button"
          >
            + New investigation
          </button>
          <div>
            {sessions.map((session) => (
              <article
                className={session.id === selectedSessionId ? "active" : ""}
                key={session.id}
              >
                <button
                  disabled={!connection.authenticated || sending || connectionBusy}
                  onClick={() => setSelectedSessionId(session.id)}
                  type="button"
                >
                  <strong>{session.title}</strong>
                  {session.readOnly && <small>Local history (read-only)</small>}
                  <time dateTime={session.updatedAt}>
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(session.updatedAt))}
                  </time>
                </button>
                <button
                  aria-label={`Delete ${session.title}`}
                  className="delete-chat-button"
                  disabled={!connection.authenticated || sending || connectionBusy}
                  onClick={() => void deleteSession(session.id).catch((nextError: Error) => setError(nextError.message))}
                  type="button"
                >
                  ×
                </button>
              </article>
            ))}
            {!loading && sessions.length === 0 && (
              <p>No saved investigations yet.</p>
            )}
          </div>
        </aside>

        <section className="service-chat-workspace">
          <div className="service-chat-context">
            <label>
              Environment
              <select
                disabled={sending}
                onChange={(event) =>
                  setContext((current) => ({
                    ...current,
                    environment: event.target.value,
                  }))
                }
                value={context.environment}
              >
                <option value="">All environments</option>
                {(service.environments ?? []).map((environment) => (
                  <option key={environment.cloud} value={environment.cloud}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Deployment
              <select
                disabled={sending}
                onChange={(event) =>
                  setContext((current) => ({
                    ...current,
                    releaseId: event.target.value,
                  }))
                }
                value={context.releaseId}
              >
                <option value="">Latest captured releases</option>
                {releases.map((release) => (
                  <option key={release.releaseId} value={release.releaseId}>
                    {release.releaseName} · {release.overallStatus}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedSession?.readOnly && (
            <p className="service-chat-legacy">This investigation predates Copilot sign-in. Its history stays local.
              Start a new investigation to use AI.</p>
          )}

          <div className="service-chat-thread" aria-live="polite">
            {messages.length === 0 && !loading ? (
              <div className="service-chat-welcome">
                <span>✦</span>
                <h2>Start a service investigation</h2>
                <p>
                  {connection.authenticated
                    ? "Copilot will use this service's evidence and recent conversation history. Repository search is bounded; deployments are captured snapshots, not live telemetry."
                    : "Connect GitHub Copilot to begin. A Microsoft 365 Copilot license alone does not provide GitHub Copilot access."}
                </p>
                <div>
                  {starterQuestions.map((starter) => (
                    <button
                      key={starter}
                      onClick={() => setQuestion(starter)}
                      type="button"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))
            )}
            {sending && (
              <div className="service-chat-thinking">
                <span />
                Investigating with GitHub Copilot...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="service-chat-composer" onSubmit={submitQuestion}>
            {error && <p role="alert">{error}</p>}
            <textarea
              disabled={sending || loading || connectionBusy || !connection.authenticated || selectedSession?.readOnly}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Describe the failure, monitor, environment, deployment, or suspected code path..."
              rows={4}
              value={question}
            />
            <footer>
              <span>
                Verify live telemetry before rollback, redeploy, or mitigation.
              </span>
              <button disabled={!question.trim() || sending || loading || connectionBusy || !connection.authenticated || selectedSession?.readOnly} type="submit">
                {sending ? "Investigating..." : "Send"}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </main>
  );
}
