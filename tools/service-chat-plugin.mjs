import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { isLocalRequest } from "./local-request.mjs";

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 250_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function listJsonRecords(root, directory) {
  const directoryPath = path.join(root, directory);
  if (!existsSync(directoryPath)) return [];
  return readdirSync(directoryPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((filePath) => ({
      filePath,
      record: readJson(filePath, undefined),
      sourcePath: path.relative(root, filePath).replaceAll(path.sep, "/"),
    }))
    .filter((entry) => entry.record);
}

function requireServiceName(value) {
  const serviceName = String(value ?? "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(serviceName)) {
    throw new Error("A valid service name is required.");
  }
  return serviceName;
}

function parseSession(row) {
  return {
    id: row.id,
    serviceName: row.service_name,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMessage(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    sources: JSON.parse(row.sources || "[]"),
    provider: row.provider || undefined,
    createdAt: row.created_at,
  };
}

function initializeDatabase(root, DatabaseSync) {
  const dataDirectory = path.join(root, ".grounds");
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(dataDirectory, "grounds.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS service_chat_sessions (
      id TEXT PRIMARY KEY,
      service_name TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_chat_sessions_service_updated
      ON service_chat_sessions(service_name, updated_at DESC);
    CREATE TABLE IF NOT EXISTS service_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES service_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      provider TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_chat_messages_session_created
      ON service_chat_messages(session_id, created_at);
  `);
  return database;
}

function searchableText(value) {
  return JSON.stringify(value).toLocaleLowerCase();
}

function overlapScore(question, values) {
  const normalizedQuestion = question.toLocaleLowerCase();
  return values.reduce(
    (score, value) =>
      score + (normalizedQuestion.includes(String(value).toLocaleLowerCase()) ? 1 : 0),
    0,
  );
}

function extractSearchTerms(question, knowledge) {
  const explicitTerms =
    question.match(/\b[A-Za-z][A-Za-z0-9_.-]{5,}\b/g) ?? [];
  const knowledgeTerms = [
    ...(knowledge?.components ?? []).flatMap((item) => item.searchTerms ?? []),
    ...(knowledge?.monitors ?? []).flatMap((item) => [
      item.name,
      ...(item.searchTerms ?? []),
      ...item.signals.flatMap((signal) => [
        signal.name,
        signal.namespace,
        signal.metric,
      ]),
    ]),
    ...(knowledge?.playbooks ?? []).flatMap((item) => item.searchTerms ?? []),
  ].filter(Boolean);
  const normalizedQuestion = question.toLocaleLowerCase();
  return [...new Set([
    ...explicitTerms,
    ...knowledgeTerms.filter((term) =>
      normalizedQuestion.includes(String(term).toLocaleLowerCase()),
    ),
  ])]
    .filter((term) => String(term).length >= 6)
    .sort((left, right) => String(right).length - String(left).length)
    .slice(0, 8);
}

function runGitGrep(repositoryPath, terms) {
  if (!repositoryPath || !existsSync(path.join(repositoryPath, ".git")) || terms.length === 0) {
    return Promise.resolve([]);
  }
  const argumentsList = ["grep", "-n", "-I", "-i"];
  for (const term of terms) argumentsList.push("-e", term);
  argumentsList.push("--", ".");

  return new Promise((resolve) => {
    const child = spawn("git", argumentsList, {
      cwd: repositoryPath,
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (chunk) => {
      if (output.length < 250_000) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(
        output
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, 30)
          .map((line) => {
            const match = line.match(/^([^:]+):(\d+):(.*)$/);
            return match
              ? {
                  path: match[1].replaceAll("\\", "/"),
                  line: Number(match[2]),
                  excerpt: match[3].trim().slice(0, 240),
                }
              : undefined;
          })
          .filter(Boolean),
      );
    });
  });
}

function sourceCollector() {
  const sources = [];
  const indexes = new Map();
  return {
    add(source) {
      const key = `${source.type}|${source.location}`;
      if (!indexes.has(key)) {
        sources.push({ id: sources.length + 1, ...source });
        indexes.set(key, sources.length);
      }
      return indexes.get(key);
    },
    values() {
      return sources;
    },
  };
}

function formatRelease(release) {
  const failedStages = release.stages
    .filter((stage) => stage.status === "failed")
    .map((stage) => stage.name);
  return `${release.releaseName} (${release.overallStatus})${
    failedStages.length ? `; failed stages: ${failedStages.join(", ")}` : ""
  }`;
}

async function synthesizeGroundedAnswer({
  root,
  question,
  service,
  serviceSourcePath,
  knowledge,
  knowledgeSourcePath,
  context,
}) {
  const sourceList = sourceCollector();
  const serviceCitation = sourceList.add({
    type: "service-catalog",
    title: `${service.service.displayName} catalog record`,
    location: serviceSourcePath,
  });
  const knowledgeCitation = knowledge
    ? sourceList.add({
        type: "troubleshooting",
        title: `${service.service.displayName} troubleshooting knowledge`,
        location: knowledgeSourcePath,
      })
    : undefined;
  const normalizedQuestion = question.toLocaleLowerCase();
  const matchingMonitors = (knowledge?.monitors ?? [])
    .map((monitor) => ({
      monitor,
      score: overlapScore(question, [
        monitor.name,
        monitor.system,
        monitor.component ?? "",
        ...monitor.searchTerms ?? [],
        ...monitor.signals.flatMap((signal) => [
          signal.name,
          signal.namespace ?? "",
          signal.metric ?? "",
        ]),
      ]),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  const matchingPlaybooks = (knowledge?.playbooks ?? [])
    .map((playbook) => ({
      playbook,
      score: overlapScore(question, [
        playbook.title,
        ...playbook.symptoms,
        ...playbook.searchTerms ?? [],
      ]),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  const releasesSnapshot = readJson(
    path.join(root, "intelligence", "srm", "release-observations.json"),
    { releases: [] },
  );
  const releases = releasesSnapshot.releases
    .filter((release) => release.serviceName === service.service.name)
    .filter((release) => {
      if (context?.releaseId) return release.releaseId === context.releaseId;
      if (!context?.environment) return true;
      return release.stages.some((stage) => stage.cloud === context.environment);
    })
    .sort(
      (left, right) =>
        new Date(right.updatedOn ?? right.observedAt).valueOf() -
        new Date(left.updatedOn ?? left.observedAt).valueOf(),
    )
    .slice(0, 4);
  const releaseCitations = releases.map((release) =>
    sourceList.add({
      type: "deployment",
      title: release.releaseName,
      location: release.releaseUrl,
      observedAt: release.observedAt,
    }),
  );
  const terms = extractSearchTerms(question, knowledge);
  const repositories = service.repositories.filter(
    (repository) =>
      repository.checkoutStatus === "available" &&
      repository.localPath &&
      existsSync(repository.localPath),
  );
  const rawCodeResults = (
    await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        matches: await runGitGrep(repository.localPath, terms),
      })),
    )
  ).flatMap(({ repository, matches }) =>
    matches.map((match) => ({
      ...match,
      repository,
    })),
  );
  const codeResults = rawCodeResults.slice(0, 10).map((match) => ({
    ...match,
    citation: sourceList.add({
        type: "repository",
        title: `${match.repository.name}: ${match.path}:${match.line}`,
        location: `${match.repository.url}?path=/${encodeURIComponent(match.path)}&line=${match.line}`,
      }),
  }));

  const lines = [];
  lines.push("## Investigation framing");
  lines.push(
    `Treat this as a correlation to prove, not proof that the deployment caused the monitor transition. ${service.service.displayName} is cataloged as ${service.service.serviceType}; its recorded impact says: ${service.operationalImpact.summary} [${serviceCitation}]`,
  );
  if (context?.environment || context?.releaseId) {
    lines.push(
      `Attached context: ${[
        context.environment && `environment **${context.environment}**`,
        context.releaseId && `release **${context.releaseId}**`,
      ].filter(Boolean).join(", ")}.`,
    );
  }

  lines.push("\n## Relevant monitor and component knowledge");
  if (matchingMonitors.length > 0) {
    for (const { monitor } of matchingMonitors.slice(0, 3)) {
      const signals = monitor.signals
        .map((signal) =>
          [signal.namespace, signal.metric].filter(Boolean).join(" / ") || signal.name,
        )
        .join("; ");
      lines.push(
        `- **${monitor.name}** (${monitor.system}): ${monitor.description} Signals: ${signals}. [${knowledgeCitation}]`,
      );
      if (monitor.knownFailureModes?.length) {
        lines.push(
          `  Check these hypotheses: ${monitor.knownFailureModes.join(" ")}`,
        );
      }
    }
  } else if (knowledge) {
    lines.push(
      `No monitor name in the question matched the service troubleshooting record. Search the enlisted repository and monitor configuration using: ${terms.join(", ") || "the exact monitor and metric names"}. [${knowledgeCitation}]`,
    );
  } else {
    lines.push(
      "This service does not yet have a troubleshooting knowledge record. Guidance below is limited to catalog and deployment evidence.",
    );
  }

  lines.push("\n## Code surfaces");
  if (codeResults.length > 0) {
    for (const match of codeResults) {
      lines.push(
        `- \`${match.path}:${match.line}\` — ${match.excerpt || "matching code"} [${match.citation}]`,
      );
    }
  } else if (repositories.length === 0) {
    lines.push(
      "No local checkout is enlisted for this service, so Grounds could not inspect implementation code. Enlist the repository locally or use the repository links from the service record.",
    );
  } else {
    lines.push(
      `No local code matches were found for the strongest terms (${terms.join(", ") || "none extracted"}). Search monitor configuration and generated deployment artifacts as well as application source.`,
    );
  }

  lines.push("\n## Telemetry and logs");
  if (knowledge?.telemetry?.length) {
    for (const telemetry of knowledge.telemetry) {
      const namespace = telemetry.namespaces?.length
        ? ` Namespace: ${telemetry.namespaces.join(", ")}.`
        : "";
      const database =
        telemetry.cluster || telemetry.database
          ? ` Kusto: ${[telemetry.cluster, telemetry.database].filter(Boolean).join(" / ")}.`
          : " The authoritative cluster/database is not cataloged; obtain it from the monitor or dashboard configuration rather than guessing.";
      lines.push(
        `- **${telemetry.name}** (${telemetry.system}): ${telemetry.purpose}.${namespace}${database} [${knowledgeCitation}]`,
      );
      for (const guidance of telemetry.queryGuidance ?? []) {
        lines.push(`  - ${guidance}`);
      }
    }
  } else {
    lines.push(
      "No service-specific telemetry locations are cataloged. Start from the monitor definition, dashboard, or runbook links and record the authoritative namespace, cluster, database, and tables in the troubleshooting record.",
    );
  }

  lines.push("\n## Deployment evidence");
  if (releases.length > 0) {
    releases.forEach((release, index) => {
      lines.push(
        `- ${formatRelease(release)}; updated ${release.updatedOn ?? release.observedAt}. [${releaseCitations[index]}]`,
      );
    });
    lines.push(
      "Align the first unhealthy sample with these stage timestamps and compare the same build in a healthy region. A matching timestamp raises confidence but does not distinguish code, configuration, infrastructure, or dependency causes.",
    );
  } else {
    lines.push(
      "No matching captured SRM release was found for the selected context. Refresh SRM or attach a release before making deployment-causality claims.",
    );
  }

  lines.push("\n## Recommended investigation");
  const steps =
    matchingPlaybooks[0]?.playbook.investigationSteps ??
    [
      "Establish the last-healthy, deployment, and first-unhealthy timestamps.",
      "Compare the deployment diff with the failing component and environment configuration.",
      "Trace the monitor from raw signal through aggregation and alert threshold.",
      "Compare the same operation and build in a healthy region.",
      "Validate downstream dependencies before choosing rollback or redeploy.",
    ];
  steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (matchingPlaybooks[0] && knowledgeCitation) {
    lines.push(`Playbook source: [${knowledgeCitation}]`);
  }

  lines.push("\n## Confidence");
  const confidence =
    matchingMonitors.length > 0 && (codeResults.length > 0 || releases.length > 0)
      ? "Medium"
      : "Low";
  lines.push(
    `**${confidence}.** Grounds found ${
      matchingMonitors.length
    } matching monitor record(s), ${codeResults.length} local code match(es), and ${
      releases.length
    } relevant captured release(s). Validate live telemetry and the actual deployment diff before acting.`,
  );

  if (
    normalizedQuestion.includes("kusto") &&
    !(knowledge?.telemetry ?? []).some(
      (item) => item.cluster || item.database || item.tables?.length,
    )
  ) {
    lines.push(
      "\nGrounds intentionally did not invent a Kusto cluster, database, or table because none is present in the trusted service knowledge.",
    );
  }

  return {
    content: lines.join("\n"),
    provider: "grounds-grounded",
    sources: sourceList.values(),
  };
}

export function serviceChatPlugin() {
  let root;
  let database;

  return {
    name: "grounds-service-chat",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const { DatabaseSync } = await import("node:sqlite");
      database = initializeDatabase(root, DatabaseSync);
    },
    configureServer(server) {
      server.httpServer?.once("close", () => database?.close());
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        if (!requestUrl.pathname.startsWith("/__grounds/service-chat/")) {
          next();
          return;
        }
        if (!isLocalRequest(request)) {
          sendJson(response, 403, { error: "Local Grounds origin required." });
          return;
        }

        try {
          const sessionMatch = requestUrl.pathname.match(
            /^\/__grounds\/service-chat\/sessions\/([^/]+)$/,
          );
          const messagesMatch = requestUrl.pathname.match(
            /^\/__grounds\/service-chat\/sessions\/([^/]+)\/messages$/,
          );

          if (requestUrl.pathname === "/__grounds/service-chat/sessions") {
            if (request.method === "GET") {
              const serviceName = requireServiceName(
                requestUrl.searchParams.get("serviceName"),
              );
              const rows = database
                .prepare(
                  `SELECT id, service_name, title, created_at, updated_at
                   FROM service_chat_sessions
                   WHERE service_name = ?
                   ORDER BY updated_at DESC`,
                )
                .all(serviceName);
              sendJson(response, 200, { sessions: rows.map(parseSession) });
              return;
            }
            if (request.method === "POST") {
              const payload = await readJsonBody(request);
              const serviceName = requireServiceName(payload.serviceName);
              const serviceRecords = listJsonRecords(root, "services");
              if (!serviceRecords.some(({ record }) => record.service?.name === serviceName)) {
                throw new Error("Service not found.");
              }
              const timestamp = new Date().toISOString();
              const session = {
                id: randomUUID(),
                serviceName,
                title: "New investigation",
                createdAt: timestamp,
                updatedAt: timestamp,
              };
              database
                .prepare(
                  `INSERT INTO service_chat_sessions
                   (id, service_name, title, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)`,
                )
                .run(
                  session.id,
                  session.serviceName,
                  session.title,
                  session.createdAt,
                  session.updatedAt,
                );
              sendJson(response, 201, { session });
              return;
            }
          } else if (messagesMatch) {
            const sessionId = decodeURIComponent(messagesMatch[1]);
            const sessionRow = database
              .prepare(
                `SELECT id, service_name, title, created_at, updated_at
                 FROM service_chat_sessions WHERE id = ?`,
              )
              .get(sessionId);
            if (!sessionRow) throw new Error("Chat session not found.");

            if (request.method === "GET") {
              const rows = database
                .prepare(
                  `SELECT id, session_id, role, content, sources, provider, created_at
                   FROM service_chat_messages
                   WHERE session_id = ?
                   ORDER BY created_at`,
                )
                .all(sessionId);
              sendJson(response, 200, { messages: rows.map(parseMessage) });
              return;
            }
            if (request.method === "POST") {
              const payload = await readJsonBody(request);
              const question = String(payload.question ?? "").trim();
              if (!question || question.length > 12_000) {
                throw new Error("Enter a question up to 12,000 characters.");
              }
              const serviceEntry = listJsonRecords(root, "services").find(
                ({ record }) => record.service?.name === sessionRow.service_name,
              );
              if (!serviceEntry) throw new Error("Service catalog record not found.");
              const knowledgeEntry = listJsonRecords(root, "troubleshooting").find(
                ({ record }) => record.serviceName === sessionRow.service_name,
              );
              const timestamp = new Date().toISOString();
              const userMessage = {
                id: randomUUID(),
                sessionId,
                role: "user",
                content: question,
                sources: [],
                createdAt: timestamp,
              };
              database
                .prepare(
                  `INSERT INTO service_chat_messages
                   (id, session_id, role, content, sources, provider, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  userMessage.id,
                  sessionId,
                  "user",
                  question,
                  "[]",
                  null,
                  timestamp,
                );
              const answer = await synthesizeGroundedAnswer({
                root,
                question,
                service: serviceEntry.record,
                serviceSourcePath: serviceEntry.sourcePath,
                knowledge: knowledgeEntry?.record,
                knowledgeSourcePath: knowledgeEntry?.sourcePath,
                context: payload.context ?? {},
              });
              const assistantMessage = {
                id: randomUUID(),
                sessionId,
                role: "assistant",
                content: answer.content,
                sources: answer.sources,
                provider: answer.provider,
                createdAt: new Date().toISOString(),
              };
              database
                .prepare(
                  `INSERT INTO service_chat_messages
                   (id, session_id, role, content, sources, provider, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  assistantMessage.id,
                  sessionId,
                  "assistant",
                  assistantMessage.content,
                  JSON.stringify(assistantMessage.sources),
                  assistantMessage.provider,
                  assistantMessage.createdAt,
                );
              const messageCount = database
                .prepare(
                  "SELECT COUNT(*) AS count FROM service_chat_messages WHERE session_id = ? AND role = 'user'",
                )
                .get(sessionId).count;
              const title =
                messageCount === 1
                  ? question.replace(/\s+/g, " ").slice(0, 72)
                  : sessionRow.title;
              database
                .prepare(
                  `UPDATE service_chat_sessions
                   SET title = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(title, assistantMessage.createdAt, sessionId);
              sendJson(response, 201, {
                assistantMessage,
                session: {
                  ...parseSession(sessionRow),
                  title,
                  updatedAt: assistantMessage.createdAt,
                },
                userMessage,
              });
              return;
            }
          } else if (sessionMatch && request.method === "DELETE") {
            const sessionId = decodeURIComponent(sessionMatch[1]);
            const result = database
              .prepare("DELETE FROM service_chat_sessions WHERE id = ?")
              .run(sessionId);
            if (result.changes === 0) throw new Error("Chat session not found.");
            sendJson(response, 200, { status: "deleted" });
            return;
          }

          sendJson(response, 405, { error: "Method not allowed." });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
