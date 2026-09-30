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
  return source.location.startsWith("http") ? (
    <a
      href={source.location}
      id={`chat-source-${source.id}`}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <div id={`chat-source-${source.id}`}>{content}</div>
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
  service,
}: {
  onBack: () => void;
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
    setLoading(true);
    requestJson<{ sessions: ServiceChatSession[] }>(
      `/__grounds/service-chat/sessions?serviceName=${encodeURIComponent(service.service.name)}`,
    )
      .then((result) => {
        if (!active) return;
        setSessions(result.sessions);
        setSelectedSessionId(result.sessions[0]?.id);
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
  }, [service.service.name]);

  useEffect(() => {
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
        if (active) setMessages(result.messages);
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
  }, [selectedSessionId]);

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
    if (!nextQuestion || sending) return;
    setSending(true);
    setError("");
    setQuestion("");
    try {
      const session =
        sessions.find((item) => item.id === selectedSessionId) ??
        (await createSession());
      const optimistic: ServiceChatMessage = {
        id: `pending-${Date.now()}`,
        sessionId: session.id,
        role: "user",
        content: nextQuestion,
        sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimistic]);
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
        ...current.filter((message) => message.id !== optimistic.id),
        result.userMessage,
        result.assistantMessage,
      ]);
      setSessions((current) => [
        result.session,
        ...current.filter((item) => item.id !== result.session.id),
      ]);
    } catch (nextError) {
      setQuestion(nextQuestion);
      setMessages((current) =>
        current.filter((message) => !message.id.startsWith("pending-")),
      );
      setError(nextError instanceof Error ? nextError.message : String(nextError));
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
        </div>
        <span className="service-chat-provider-status">
          <span />
          Grounds grounded provider
        </span>
      </header>

      <div className="service-chat-layout">
        <aside className="service-chat-sessions">
          <button
            className="new-chat-button"
            onClick={() => void createSession()}
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
                  onClick={() => setSelectedSessionId(session.id)}
                  type="button"
                >
                  <strong>{session.title}</strong>
                  <time dateTime={session.updatedAt}>
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(session.updatedAt))}
                  </time>
                </button>
                <button
                  aria-label={`Delete ${session.title}`}
                  className="delete-chat-button"
                  onClick={() => void deleteSession(session.id)}
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

          <div className="service-chat-thread" aria-live="polite">
            {messages.length === 0 && !loading ? (
              <div className="service-chat-welcome">
                <span>✦</span>
                <h2>Start a service investigation</h2>
                <p>
                  Grounds will correlate catalog knowledge, troubleshooting records,
                  captured deployments, and matching local source code.
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
                Correlating service evidence...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="service-chat-composer" onSubmit={submitQuestion}>
            {error && <p role="alert">{error}</p>}
            <textarea
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
              <button disabled={!question.trim() || sending} type="submit">
                {sending ? "Investigating..." : "Send"}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </main>
  );
}
