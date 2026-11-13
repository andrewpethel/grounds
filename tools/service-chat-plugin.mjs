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
import { copilotError, createCopilotRuntime } from "./copilot-runtime.mjs";
import { createArchitectureFlows } from "./architecture-flows.mjs";

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
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw copilotError(`Grounds could not read ${path.basename(filePath)}. Fix the invalid or inaccessible local record and retry.`);
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
    readOnly: !row.operator_id,
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
    context: JSON.parse(row.context || "{}"),
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
  if (!database.prepare("PRAGMA table_info(service_chat_sessions)").all()
    .some((column) => column.name === "operator_id")) {
    database.exec("ALTER TABLE service_chat_sessions ADD COLUMN operator_id TEXT");
  }
  if (!database.prepare("PRAGMA table_info(service_chat_messages)").all()
    .some((column) => column.name === "context")) {
    database.exec("ALTER TABLE service_chat_messages ADD COLUMN context TEXT NOT NULL DEFAULT '{}'");
  }
  return database;
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

function runGitGrep(repositoryPath, terms, sourcePaths) {
  if (!repositoryPath || !existsSync(path.join(repositoryPath, ".git")) || terms.length === 0) {
    return Promise.resolve([]);
  }
  const argumentsList = ["--no-pager", "-c", "core.fsmonitor=false", "grep", "-n", "-I", "-i", "-F"];
  for (const term of terms) argumentsList.push("-e", term);
  argumentsList.push("--", ...(sourcePaths?.length ? sourcePaths.map((source) => `:(literal)${source}`) : ["."]),
    ...["**/.env*", "**/*.pem", "**/*.pfx", "**/*.key", "**/credentials*", "**/secrets*"]
      .map((pattern) => `:(exclude,icase)${pattern}`));

  return new Promise((resolve, reject) => {
    const child = spawn("git", argumentsList, {
      cwd: repositoryPath,
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(copilotError("Repository evidence search timed out. Narrow the question and retry."));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      if (output.length < 250_000) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(copilotError("Git could not search the selected repository. Check that Git is installed and the checkout is accessible."));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== 1) {
        reject(copilotError("Repository evidence search failed. Check access to the selected checkout."));
        return;
      }
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
        sources.push({ ...source, id: sources.length + 1 });
        indexes.set(key, sources.length);
      }
      return indexes.get(key);
    },
    values() {
      return sources;
    },
  };
}

async function collectServiceEvidence({
  root,
  question,
  service,
  serviceSourcePath,
  knowledge,
  knowledgeSourcePath,
  context,
  purpose = "troubleshooting",
  savedFlow,
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
  const terms = purpose === "architecture"
    ? ["architecture", "dependency", "HttpClient", "HttpTrigger", "ServiceBus", "CosmosClient",
        "BlobServiceClient", "QueueClient", "Kafka", "Kusto", "ingress", "egress",
        "Microsoft.Storage", "Microsoft.Web", "privateEndpoint", "resource ", "module "]
    : extractSearchTerms(question, knowledge);
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
        matches: await runGitGrep(repository.localPath, terms, repository.paths),
      })),
    )
  ).flatMap(({ repository, matches }) =>
    matches.map((match) => ({
      ...match,
      repository,
    })),
  );
  const codeResults = rawCodeResults
    .filter((match) => purpose !== "architecture" ||
      !/(?:password|secret|token|api[-_]?key|connectionstring)\s*["']?\s*[:=]/i.test(match.excerpt))
    .slice(0, purpose === "architecture" ? 40 : 10).map((match) => ({
    ...match,
    citation: sourceList.add({
        type: "repository",
        title: `${match.repository.name}: ${match.path}:${match.line}`,
        location: `${match.repository.url}?path=/${encodeURIComponent(match.path)}&line=${match.line}`,
      }),
  }));

  let architecture;
  if (savedFlow) {
    const sourceId = sourceList.add({
      type: "architecture", title: `${service.service.displayName} ${savedFlow.status} architecture flow`,
      location: `#/service/${service.service.name}/flow`, observedAt: savedFlow.generatedAt,
    });
    const citations = new Map(savedFlow.sources.map((source) => [source.id, sourceList.add(source)]));
    const remap = (entry) => ({ ...entry, evidenceSourceIds: entry.evidenceSourceIds.map((id) => citations.get(id)) });
    architecture = {
      sourceId, id: savedFlow.id, status: savedFlow.status, generatedAt: savedFlow.generatedAt,
      reviewedAt: savedFlow.reviewedAt, catalogChanged: savedFlow.catalogChanged,
      repositories: savedFlow.repositories,
      codeEvidence: savedFlow.codeEvidence.map((entry) => ({ ...entry, sourceId: citations.get(entry.sourceId) })),
      ...savedFlow.graph,
      nodes: savedFlow.graph.nodes.map(remap), edges: savedFlow.graph.edges.map(remap),
      limitation: "A bounded logical source snapshot, not live deployed topology. Operator review is not independent verification. Repository changes are not monitored.",
    };
  }
  return {
    catalog: { sourceId: serviceCitation, service: service.service, impact: service.operationalImpact, dependencies: service.dependencies ?? [] },
    architecture,
    knowledge: {
      sourceId: knowledgeCitation,
      monitors: matchingMonitors.slice(0, 3).map(({ monitor }) => monitor),
      playbooks: matchingPlaybooks.slice(0, 3).map(({ playbook }) => playbook),
      telemetry: knowledge?.telemetry ?? [],
    },
    deployments: releases.map((release, index) => ({ ...release, sourceId: releaseCitations[index] })),
    code: codeResults.map((match) => ({
      path: match.path, line: match.line, excerpt: match.excerpt, sourceId: match.citation,
    })),
    limitations: {
      availableCheckouts: repositories.length,
      codeSearch: "Bounded literal search of tracked files in cataloged source paths, excluding common credential files. Not a complete repository analysis.",
      telemetry: "Captured deployment snapshots only; no live telemetry, ADO Boards, or IcM retrieval.",
    },
    sources: sourceList.values(),
  };
}

export function buildInvestigationPrompt(question, context, evidence, messages, totalMessages = messages.length) {
  const sourceList = sourceCollector();
  for (const source of evidence.sources) sourceList.add(source);
  let remaining = 32_000;
  const history = [];
  for (const message of [...messages].reverse()) {
    if (history.length >= 24 || message.content.length > remaining) break;
    remaining -= message.content.length;
    const citations = new Map(message.sources.map((source) => [source.id, sourceList.add(source)]));
    history.unshift({
      role: message.role,
      content: message.content.replace(/\[(\d+)]/g, (match, id) => citations.has(Number(id)) ? `[${citations.get(Number(id))}]` : match),
      createdAt: message.createdAt,
      context: message.context,
    });
  }
  const sources = sourceList.values();
  const prompt = JSON.stringify({
    question, selectedContext: context, evidence: { ...evidence, sources: undefined },
    history, earlierMessagesOmitted: Math.max(0, totalMessages - history.length), sources,
  });
  if (prompt.length > 96_000) throw copilotError("The selected evidence is too large. Narrow the deployment context and retry.", 400);
  return { prompt, sources };
}

export function serviceChatPlugin({ copilot: providedCopilot } = {}) {
  let root;
  let database;
  let copilot = providedCopilot;
  let architecture;

  function findService(serviceName) {
    const entry = listJsonRecords(root, "services").find(({ record }) => record.service?.name === serviceName);
    if (!entry) throw copilotError("Service catalog record not found.", 404);
    return entry;
  }

  function closeDatabase() {
    database?.close();
    database = undefined;
  }

  return {
    name: "grounds-service-chat",
    apply: "serve",
    async closeBundle() {
      await architecture?.close();
      closeDatabase();
      if (!providedCopilot) await copilot?.close();
    },
    async configResolved(config) {
      root = config.root;
      const { DatabaseSync } = await import("node:sqlite");
      database = initializeDatabase(root, DatabaseSync);
      copilot ??= createCopilotRuntime(root);
      architecture = createArchitectureFlows({
        database, copilot, findService,
        collectEvidence: async (entry) => {
          const knowledgeEntry = listJsonRecords(root, "troubleshooting").find(
            ({ record }) => record.serviceName === entry.record.service.name,
          );
          return collectServiceEvidence({
            root, question: "architecture components dependencies", purpose: "architecture",
            service: entry.record, serviceSourcePath: entry.sourcePath,
            knowledge: knowledgeEntry?.record, knowledgeSourcePath: knowledgeEntry?.sourcePath,
          });
        },
      });
    },
    configureServer(server) {
      server.httpServer?.once("close", () => {
        void architecture.close().then(closeDatabase).catch((error) =>
          console.error("Architecture shutdown failed:", error));
      });
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
          const copilotMatch = requestUrl.pathname.match(
            /^\/__grounds\/service-chat\/copilot\/(status|login|cancel|logout)$/,
          );
          if (copilotMatch) {
            const action = copilotMatch[1];
            if (action === "status" && request.method === "GET") {
              sendJson(response, 200, await copilot.status());
              return;
            }
            if (request.method === "POST" && action !== "status") {
              if (action === "login") {
                const payload = await readJsonBody(request);
                if (payload.selectionId !== undefined && typeof payload.selectionId !== "string") {
                  throw copilotError("Choose a valid sign-in account.", 400);
                }
                sendJson(response, 200, await copilot.login(payload.selectionId));
              } else if (action === "logout") {
                sendJson(response, 200, await copilot.logout());
              } else {
                await copilot.cancelLogin();
                sendJson(response, 200, await copilot.status());
              }
              return;
            }
            sendJson(response, 405, { error: "Method not allowed." });
            return;
          }
          const actor = await copilot.operator();
          const architectureMatch = requestUrl.pathname.match(
            /^\/__grounds\/service-chat\/architecture\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/cancel)?$/,
          );
          if (architectureMatch) {
            const serviceName = requireServiceName(architectureMatch[1]);
            if (architectureMatch[2] && request.method === "POST") {
              sendJson(response, 200, { job: await architecture.cancel(actor, serviceName) });
              return;
            }
            if (!architectureMatch[2]) {
              if (request.method === "GET") {
                sendJson(response, 200, architecture.get(actor, serviceName));
                return;
              }
              if (request.method === "POST") {
                sendJson(response, 202, { job: architecture.start(actor, serviceName) });
                return;
              }
              if (request.method === "PUT") {
                const payload = await readJsonBody(request);
                sendJson(response, 200, architecture.review(actor, serviceName, payload.flowId));
                return;
              }
            }
            sendJson(response, 405, { error: "Method not allowed." });
            return;
          }
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
                  `SELECT id, service_name, title, created_at, updated_at, operator_id
                   FROM service_chat_sessions
                   WHERE service_name = ? AND (operator_id = ? OR operator_id IS NULL)
                   ORDER BY updated_at DESC`,
                )
                .all(serviceName, actor.operatorId);
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
                readOnly: false,
              };
              database
                .prepare(
                  `INSERT INTO service_chat_sessions
                   (id, service_name, title, created_at, updated_at, operator_id)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  session.id,
                  session.serviceName,
                  session.title,
                  session.createdAt,
                  session.updatedAt,
                  actor.operatorId,
                );
              sendJson(response, 201, { session });
              return;
            }
          } else if (messagesMatch) {
            const sessionId = decodeURIComponent(messagesMatch[1]);
            const sessionRow = database
              .prepare(
                `SELECT id, service_name, title, created_at, updated_at, operator_id
                 FROM service_chat_sessions WHERE id = ? AND (operator_id = ? OR operator_id IS NULL)`,
              )
              .get(sessionId, actor.operatorId);
            if (!sessionRow) throw new Error("Chat session not found.");

            if (request.method === "GET") {
              const rows = database
                .prepare(
                  `SELECT id, session_id, role, content, sources, provider, created_at, context
                   FROM service_chat_messages
                   WHERE session_id = ?
                   ORDER BY rowid`,
                )
                .all(sessionId);
              sendJson(response, 200, { messages: rows.map(parseMessage) });
              return;
            }
            if (request.method === "POST") {
              if (!sessionRow.operator_id) {
                throw copilotError("This is a pre-Copilot local investigation. Start a new investigation to use AI; the original history remains read-only.", 409);
              }
              const payload = await readJsonBody(request);
              const question = typeof payload.question === "string" ? payload.question.trim() : "";
              if (!question || question.length > 12_000) {
                throw new Error("Enter a question up to 12,000 characters.");
              }
              const context = {};
              for (const key of ["environment", "releaseId"]) {
                const value = payload.context?.[key];
                if (value !== undefined && (typeof value !== "string" || value.length > 256)) {
                  throw copilotError("Choose a valid environment and deployment context.", 400);
                }
                if (value) context[key] = value;
              }
              const result = await copilot.investigate(sessionId, async (account, generate) => {
                if (account.operatorId !== sessionRow.operator_id) throw copilotError("The Copilot account changed. Reopen this investigation with its original account.", 401);
                const serviceEntry = listJsonRecords(root, "services").find(
                  ({ record }) => record.service?.name === sessionRow.service_name,
                );
                if (!serviceEntry) throw new Error("Service catalog record not found.");
                const knowledgeEntry = listJsonRecords(root, "troubleshooting").find(
                  ({ record }) => record.serviceName === sessionRow.service_name,
                );
                const messages = database.prepare(
                  `SELECT id, session_id, role, content, sources, provider, created_at, context
                   FROM service_chat_messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 24`,
                ).all(sessionId).reverse().map(parseMessage);
                const evidence = await collectServiceEvidence({
                  root, question: [question, ...messages.filter((message) => message.role === "user").slice(-2).map((message) => message.content)].join("\n"),
                  service: serviceEntry.record, serviceSourcePath: serviceEntry.sourcePath,
                  knowledge: knowledgeEntry?.record, knowledgeSourcePath: knowledgeEntry?.sourcePath, context,
                  savedFlow: architecture.get(account, sessionRow.service_name).flow,
                });
                const { count } = database.prepare("SELECT COUNT(*) AS count FROM service_chat_messages WHERE session_id = ?").get(sessionId);
                const { prompt, sources } = buildInvestigationPrompt(question, context, evidence, messages, count);
                const content = await generate(prompt);
                const cited = new Set([...content.matchAll(/\[(\d+)]/g)].map((match) => Number(match[1])));
                if ([...cited].some((id) => !sources.some((source) => source.id === id))) {
                  throw copilotError("Copilot returned an unsupported evidence citation. Retry the question.");
                }
                const timestamp = new Date().toISOString();
                const userMessage = {
                  id: randomUUID(), sessionId, role: "user", content: question,
                  sources: [], createdAt: timestamp, context,
                };
                const assistantMessage = {
                  id: randomUUID(), sessionId, role: "assistant", content,
                  sources: sources.filter((source) => cited.has(source.id)),
                  provider: "github-copilot", createdAt: timestamp,
                };
                const title = messages.length ? sessionRow.title : question.replace(/\s+/g, " ").slice(0, 72);
                database.exec("BEGIN IMMEDIATE");
                try {
                  const insert = database.prepare(
                    `INSERT INTO service_chat_messages
                     (id, session_id, role, content, sources, provider, created_at, context)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  );
                  for (const message of [userMessage, assistantMessage]) {
                    insert.run(message.id, sessionId, message.role, message.content,
                      JSON.stringify(message.sources), message.provider ?? null, message.createdAt, JSON.stringify(message.context ?? {}));
                  }
                  database.prepare("UPDATE service_chat_sessions SET title = ?, updated_at = ? WHERE id = ?")
                    .run(title, timestamp, sessionId);
                  database.exec("COMMIT");
                } catch (error) {
                  database.exec("ROLLBACK");
                  throw error;
                }
                return {
                  assistantMessage, userMessage,
                  session: { ...parseSession(sessionRow), title, updatedAt: timestamp },
                };
              });
              sendJson(response, 201, result);
              return;
            }
          } else if (sessionMatch && request.method === "DELETE") {
            const sessionId = decodeURIComponent(sessionMatch[1]);
            if (copilot.isInvestigating(sessionId)) throw copilotError("Wait for this investigation to finish before deleting it.", 409);
            const result = database
              .prepare("DELETE FROM service_chat_sessions WHERE id = ? AND (operator_id = ? OR operator_id IS NULL)")
              .run(sessionId, actor.operatorId);
            if (result.changes === 0) throw new Error("Chat session not found.");
            sendJson(response, 200, { status: "deleted" });
            return;
          }

          sendJson(response, 405, { error: "Method not allowed." });
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
