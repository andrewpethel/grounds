import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCopilotRuntime, copilotEnvironment } from "../tools/copilot-runtime.mjs";
import { buildInvestigationPrompt } from "../tools/service-chat-plugin.mjs";
import { createServiceRecord } from "../tools/service-onboarding.mjs";
import { createBackend, initializeData } from "./backend.mjs";
import { parseArchitecture } from "../tools/architecture-flows.mjs";

const exec = promisify(execFile);
const resources = path.resolve(import.meta.dirname, "..");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grounds-copilot-test-"));
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const state = {
    authenticated: false, login: "operator-a", loginStatus: "completed",
    url: "https://github.com/login/oauth/authorize?client_id=fixture",
    clients: [], sessions: [], prompts: [], removed: [], cancelled: [], mutations: [], truncated: [],
  };
  const createClient = async (options) => {
    state.clients.push(options);
    return {
      async start() {},
      async stop() { state.stops = (state.stops ?? 0) + 1; return []; },
      async deleteSession(id) { state.removed.push(id); },
      async createSession(config) {
        const listeners = new Set();
        const session = {
          sessionId: `sdk-session-${state.sessions.length}`,
          authenticated: false,
          login: undefined,
          events: [],
          config,
          async sendAndWait({ prompt }) {
            assert.equal(session.authenticated, true, "Only the session explicitly signed in can send.");
            assert.equal(session.events.length, 0, "Earlier service context must be cleared.");
            state.prompts.push(JSON.parse(prompt));
            session.events.push({ id: `user-${state.prompts.length}`, type: "user.message" });
            if (state.errorEvent) {
              for (const listener of listeners) listener({ type: "session.error", data: state.errorEvent });
              throw new Error("Synthetic provider error");
            }
            const result = state.send ? await state.send(prompt) : { data: { content: "Inspect the cataloged component first. [1]" } };
            session.events.push({ id: `assistant-${state.prompts.length}`, type: "assistant.message" });
            return result;
          },
          on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async getEvents() { return session.events; },
          async abort() { state.abort?.(); },
          async disconnect() {},
          rpc: {
            accounts: {
              async get() {
                const result = { kind: "status", status: {
                  isAuthenticated: session.authenticated, activeLogin: session.login,
                  activeHost: "https://github.com", accountCount: session.authenticated ? 1 : 0,
                } };
                return state.getStatus ? state.getStatus(result) : result;
              },
              async enumerate() {
                return { kind: "accounts", items: session.authenticated ? [
                  { login: session.login, host: "https://github.com", selectionId: session.login },
                ] : [] };
              },
              async set({ command }) {
                state.mutations.push(command);
                if (command.kind === "logout") state.authenticated = session.authenticated = false;
                return { ok: !state.refuseSwitch };
              },
              login: {
                async begin(request) {
                  assert.deepEqual(request, { kind: "githubDotCom", mode: "default" });
                  if (state.begin) return state.begin();
                  return { flowId: `login-${state.cancelled.length}`, step: { kind: "open-url", url: state.url } };
                },
                async advance(params) {
                  let result;
                  if (state.advance) result = await state.advance(params);
                  else {
                    state.authenticated = true;
                    result = { kind: "completed", result: { status: state.loginStatus } };
                  }
                  if (state.authenticated && result.kind === "completed") {
                    session.authenticated = true;
                    session.login = state.login;
                  }
                  return result;
                },
                async cancel({ flowId }) { state.cancelled.push(flowId); state.cancel?.(); },
              },
            },
            history: {
              async truncate({ eventId }) {
                if (state.failCleanup) throw new Error("Synthetic history cleanup failure");
                const index = session.events.findIndex((event) => event.id === eventId);
                assert.notEqual(index, -1);
                const removed = session.events.splice(index);
                state.truncated.push(removed);
                return { eventsRemoved: removed.length };
              },
            },
          },
        };
        state.sessions.push(session);
        return session;
      },
    };
  };
  const copilot = createCopilotRuntime(root, { createClient, ...options });
  cleanups.push(() => copilot.close());
  async function connect() {
    await copilot.login();
    await setImmediate();
    return copilot.status();
  }
  return { root, state, copilot, connect, cleanup: (action) => cleanups.push(action) };
}

test("Copilot requires explicit sign-in, strips ambient tokens, and exposes no execution tools", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  assert.equal((await copilot.status()).authenticated, false);
  assert.equal(state.clients.length, 0);
  await assert.rejects(copilot.operator(), /Connect GitHub Copilot/);
  const connected = await connect();
  assert.equal(connected.login, "operator-a");
  assert.equal(state.clients[0].useLoggedInUser, false);
  assert.deepEqual(copilotEnvironment({
    GH_TOKEN: "not-a-real-token", GITHUB_TOKEN: "not-a-real-token",
    COPILOT_DISABLE_KEYTAR: "1", COPILOT_ALLOW_PLAINTEXT: "true",
    COPILOT_CLI_PATH: "untrusted-runtime", NODE_OPTIONS: "--inspect",
    ELECTRON_RUN_AS_NODE: "1", PATH: "fixture-path",
  }), { PATH: "fixture-path" });
  for (const session of state.sessions) {
    assert.deepEqual(session.config.availableTools, []);
    assert.equal(session.config.enableConfigDiscovery, false);
    assert.equal(session.config.enableFileHooks, false);
    assert.equal(session.config.enableSessionStore, false);
    assert.equal(session.config.remoteSession, "off");
    assert.notEqual(session.config.onPermissionRequest().kind, "approved");
  }
});

test("Copilot refuses plaintext credential persistence even if runtime reports an authenticated account", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  state.loginStatus = "needs-plaintext-consent";
  const status = await connect();
  assert.equal(state.authenticated, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error, /refused plaintext/);
  assert.equal(state.cancelled.length, 1);
  await assert.rejects(copilot.operator(), { statusCode: 401 });
  assert.equal(state.prompts.length, 0);
});

test("unsupported sign-in destinations and cancelled flows cannot authenticate Grounds", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  state.url = "https://github.com.attacker.example/login";
  const rejected = await connect();
  assert.equal(rejected.authenticated, false);
  assert.match(rejected.error, /unsupported sign-in address/);
  state.url = "https://github.com/login/oauth/authorize?client_id=fixture";
  let resolve;
  state.advance = () => new Promise((done) => { resolve = done; });
  await copilot.login();
  await setImmediate();
  assert.equal((await copilot.status()).signingIn, true);
  await copilot.cancelLogin();
  resolve({ kind: "completed", result: { status: "completed" } });
  await setImmediate();
  assert.equal((await copilot.status()).authenticated, false);
});

test("AI requests use the signed-in session, serialize investigations, and clear failed context without signing out", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  await connect();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  state.send = async () => { await gate; throw new Error("fixture transport failure"); };
  const result = copilot.investigate("chat-one", (_account, generate) => generate('{"question":"fixture"}'));
  const rejected = assert.rejects(result, /could not complete.*entitlement/);
  await setImmediate();
  await assert.rejects(copilot.investigate("chat-two", () => {}), /already running/);
  await assert.rejects(copilot.logout(), /current investigation/);
  release();
  await rejected;
  assert.equal(state.sessions.length, 1, "A fresh SDK session would have no signed-in account.");
  assert.equal(state.truncated.length, 1);
  assert.equal(state.removed.length, 0, "Authentication is retained until shutdown.");
  assert.equal((await copilot.status()).authenticated, true, "A transport failure is not a sign-out.");
  assert.equal(copilot.isInvestigating("chat-one"), false);
  state.send = undefined;
  await copilot.investigate("different-service", (_account, generate) => generate("{}"));
  assert.equal(state.truncated.length, 2);
  assert.equal(state.sessions[0].events.length, 0);
});

test("rejected authentication stays disconnected despite stale SDK status and reconnects to the same history owner", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  const original = await connect();
  state.errorEvent = { errorType: "authentication", statusCode: 401, message: "Rejected credential" };
  await assert.rejects(copilot.investigate("chat-one", (_account, generate) => generate("{}")), { statusCode: 401 });
  assert.equal(state.sessions[0].authenticated, true, "The provider may retain stale local authentication.");
  const disconnected = await copilot.status();
  assert.equal(disconnected.authenticated, false);
  assert.equal(disconnected.reconnectRequired, true);
  assert.equal(disconnected.operatorId, original.operatorId);
  await assert.rejects(copilot.operator(), { statusCode: 401 });
  await assert.rejects(copilot.investigate("chat-one", () => assert.fail("Must not run")), { statusCode: 401 });
  state.errorEvent = undefined;
  assert.equal((await connect()).operatorId, original.operatorId);
  assert.equal((await copilot.status()).authenticated, true);
  await copilot.investigate("chat-one", (_account, generate) => generate("{}"));
});

test("expired or changed native identities cannot remain connected or send under another account", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  const original = await connect();
  state.sessions[0].authenticated = false;
  assert.equal((await copilot.status()).authenticated, false);
  await assert.rejects(copilot.operator(), { statusCode: 401 });
  await connect();
  state.sessions[0].login = "unselected-operator";
  await assert.rejects(copilot.investigate("chat-one", () => assert.fail("Must not run")), /account changed/);
  assert.equal((await copilot.status()).operatorId, original.operatorId);
  assert.equal(state.prompts.length, 0);
});

test("a delayed native status response cannot restore connection after authentication is rejected", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  await connect();
  let release;
  state.getStatus = (result) => {
    state.getStatus = undefined;
    return new Promise((resolve) => { release = () => resolve(result); });
  };
  const stale = copilot.status();
  await setImmediate();
  state.errorEvent = { errorType: "authentication", statusCode: 401 };
  try {
    await assert.rejects(copilot.investigate("chat-one", (_account, generate) => generate("{}")), { statusCode: 401 });
  } finally {
    release();
  }
  assert.equal((await stale).authenticated, false);
});

test("policy and quota errors retain authentication but unsafe history cleanup requires a restart", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  await connect();
  for (const errorType of ["authorization", "policy", "quota", "rate_limit"]) {
    state.errorEvent = { errorType, statusCode: errorType === "rate_limit" ? 429 : 403 };
    await assert.rejects(copilot.investigate("chat-one", (_account, generate) => generate("{}")), { statusCode: 502 });
    assert.equal((await copilot.status()).authenticated, true);
  }
  state.errorEvent = undefined;
  state.failCleanup = true;
  await assert.rejects(copilot.investigate("chat-one", (_account, generate) => generate("{}")), /cleanup failed/);
  const status = await copilot.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.restartRequired, true);
  await assert.rejects(copilot.login(), /Restart Grounds/);
});

test("account selection validates opaque choices and prevents concurrent login startup", async (t) => {
  const { copilot, state } = await fixture(t);
  let release;
  state.begin = () => new Promise((resolve) => { release = resolve; });
  state.advance = async ({ input }) => {
    if (!input) return {
      kind: "completed", result: { status: "needs-account-selection", accounts: [
        { selectionId: "opaque-choice", login: state.login, host: "https://github.com" },
      ] },
    };
    assert.equal(input, "opaque-choice");
    state.authenticated = true;
    return { kind: "completed", result: { status: "completed" } };
  };
  const signingIn = copilot.login();
  await setImmediate();
  try {
    await assert.rejects(copilot.login(), { statusCode: 409 });
  } finally {
    release({ flowId: "selection-flow", step: { kind: "awaiting" } });
  }
  await signingIn;
  await setImmediate();
  const status = await copilot.status();
  assert.equal(status.choices[0].selectionId, "opaque-choice");
  assert.equal(status.authenticated, false);
  await assert.rejects(copilot.login("not-an-offered-choice"), /Choose an account/);
  await copilot.login("opaque-choice");
  await setImmediate();
  assert.equal((await copilot.status()).authenticated, true);
});

test("timed-out sign-in is cancelled without authenticating or leaving a background job", async (t) => {
  const { copilot, state } = await fixture(t, { loginTimeout: 20 });
  let release;
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  state.advance = () => new Promise((resolve) => { release = resolve; });
  state.cancel = () => { release({ kind: "error" }); cancelled(); };
  await copilot.login();
  await cancellation;
  await setImmediate();
  const status = await copilot.status();
  assert.equal(status.signingIn, false);
  assert.equal(status.authenticated, false);
  assert.match(status.error, /timed out/);
});

test("shutdown aborts and drains an active investigation and stops the runtime only once", async (t) => {
  const { copilot, state, connect } = await fixture(t);
  await connect();
  let reject;
  state.send = () => new Promise((_resolve, fail) => { reject = fail; });
  state.abort = () => reject(new Error("fixture aborted"));
  const investigation = copilot.investigate("closing", (_account, generate) => generate("{}"));
  const rejected = assert.rejects(investigation, /could not complete/);
  await setImmediate();
  await Promise.all([copilot.close(), copilot.close(), rejected]);
  assert.equal(state.stops, 1);
  assert.equal(state.removed.length, 1, "The shared authenticated SDK session is removed.");
  await assert.rejects(copilot.operator(), /Connect/);
});

test("conversation prompts bound history and remap old citations without confusing new sources", () => {
  const source = { id: 1, type: "repository", title: "Current file", location: "https://example.com/current" };
  const old = { ...source, title: "Old file", location: "https://example.com/old" };
  const messages = [
    { role: "user", content: "Earlier context", sources: [], createdAt: "2026-01-01" },
    { role: "assistant", content: "Look here [1]", sources: [old], createdAt: "2026-01-01" },
  ];
  const result = buildInvestigationPrompt("Why?", {}, { sources: [source] }, messages, 40);
  const prompt = JSON.parse(result.prompt);
  assert.equal(prompt.history[1].content, "Look here [2]");
  assert.equal(result.sources[1].id, 2);
  assert.equal(result.sources[1].location, old.location);
  assert.equal(prompt.earlierMessagesOmitted, 38);
  const bounded = JSON.parse(buildInvestigationPrompt("Next", {}, { sources: [] },
    Array.from({ length: 30 }, () => ({ role: "user", content: "x".repeat(2000), sources: [] }))).prompt);
  assert.equal(bounded.history.length, 16);
  assert.equal(bounded.earlierMessagesOmitted, 14);
});

test("chat persists operator-scoped history and context, searches only service paths, and survives backend replacement", async (t) => {
  const { root, state, copilot, connect, cleanup } = await fixture(t);
  await initializeData(root, resources);
  const repository = path.join(root, "repository");
  await fs.mkdir(path.join(repository, "component"), { recursive: true });
  await exec("git", ["init", "--quiet", repository]);
  await fs.writeFile(path.join(repository, "component", "Monitor.cs"), "class HealthMonitor { bool Healthy = false; }\n");
  await fs.writeFile(path.join(repository, "Outside.cs"), "HealthMonitor unrelated component\n");
  await fs.writeFile(path.join(repository, "component", "secrets.json"), "HealthMonitor credential fixture\n");
  await exec("git", ["-C", repository, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "."]);
  const { record } = createServiceRecord({
    serviceName: "fixture-service", displayName: "Fixture Service", description: "Fixture investigation service",
    repositoryUrl: "https://github.com/grounds-fixture/service", defaultBranch: "main",
  });
  Object.assign(record.repositories[0], { localPath: repository, checkoutStatus: "available", paths: ["component"] });
  await fs.writeFile(path.join(root, "services", "fixture.json"), JSON.stringify(record));
  const open = () => createBackend(root, () => {}, { copilot });
  let backend = await open();
  cleanup(() => backend.close());
  const request = async (route, method = "GET", body) => {
    const result = await backend.request({
      path: `/__grounds/service-chat/${route}`, method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, ...JSON.parse(result.body) };
  };
  assert.equal((await request("sessions?serviceName=fixture-service")).status, 401);
  await connect();
  const { session } = await request("sessions", "POST", { serviceName: "fixture-service" });
  const route = `sessions/${session.id}/messages`;
  let answer = await request(route, "POST", { question: "Explain HealthMonitor", context: { environment: "public" } });
  assert.equal(answer.status, 201, JSON.stringify(answer));
  assert.equal(answer.assistantMessage.provider, "github-copilot");
  assert.equal(state.prompts[0].history.length, 0);
  assert.deepEqual(state.prompts[0].evidence.code.map((item) => item.path), ["component/Monitor.cs"]);
  assert.equal(state.prompts[0].selectedContext.environment, "public");
  let release;
  let started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  const modelReply = new Promise((resolve) => { release = resolve; });
  state.send = () => { started(); return modelReply; };
  const pending = request(route, "POST", { question: "What should I compare next?" });
  await modelStarted;
  const retired = backend.close();
  try {
    backend = await open();
    assert.equal((await copilot.status()).authenticated, true);
    release({ data: { content: "Compare the operator's prior observation. [1]" } });
    answer = await pending;
  } finally {
    release({ data: { content: "Fixture cleanup. [1]" } });
    await retired;
  }
  assert.equal(answer.status, 201, JSON.stringify(answer));
  assert.equal(state.prompts[1].history.length, 2);
  assert.equal(state.prompts[1].history[0].context.environment, "public");
  state.send = async () => { throw new Error("fixture offline"); };
  const failed = await request(route, "POST", { question: "Keep my failed draft" });
  assert.equal(failed.status, 502);
  assert.equal((await request(route)).messages.length, 4, "Failed turns never create success-shaped or duplicate messages.");
  state.send = async () => ({ data: { content: "Unsupported evidence [999]" } });
  assert.equal((await request(route, "POST", { question: "Bad citation" })).status, 502);
  assert.equal((await request(route)).messages.length, 4);
  const broken = path.join(root, "troubleshooting", "broken.json");
  await fs.writeFile(broken, "{not valid JSON");
  const promptsBefore = state.prompts.length;
  try {
    const invalidEvidence = await request(route, "POST", { question: "Do not ignore a broken evidence record" });
    assert.equal(invalidEvidence.status, 502);
    assert.match(invalidEvidence.error, /could not read broken.json/);
    assert.equal(state.prompts.length, promptsBefore);
  } finally {
    await fs.unlink(broken);
  }
  state.errorEvent = { errorType: "authentication", statusCode: 401 };
  assert.equal((await request(route, "POST", { question: "Authentication expired mid-question" })).status, 401);
  assert.equal((await request("copilot/status")).authenticated, false);
  assert.equal((await request(route)).status, 401);
  state.errorEvent = undefined;
  await connect();
  assert.equal((await request(route)).messages.length, 4, "Rejected authentication never persists a partial exchange.");
  await copilot.logout();
  state.login = "operator-b";
  await connect();
  assert.deepEqual((await request("sessions?serviceName=fixture-service")).sessions, []);
  assert.equal((await request(route)).status, 400);
  assert.equal((await request(`sessions/${session.id}`, "DELETE")).status, 400);
  await copilot.logout();
  state.login = "operator-a";
  await connect();
  assert.equal((await request(route)).messages.length, 4);
});

test("legacy chat migration preserves local history but never sends it to the model", async (t) => {
  const { root, copilot, connect, state, cleanup } = await fixture(t);
  await initializeData(root, resources);
  await fs.mkdir(path.join(root, ".grounds"), { recursive: true });
  const database = new DatabaseSync(path.join(root, ".grounds", "grounds.db"));
  database.exec(`
    CREATE TABLE service_chat_sessions (id TEXT PRIMARY KEY, service_name TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE service_chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT, provider TEXT, created_at TEXT);
    INSERT INTO service_chat_sessions VALUES ('legacy', 'fixture-service', 'Old investigation', '2026-01-01', '2026-01-01');
    INSERT INTO service_chat_messages VALUES ('message', 'legacy', 'user', 'Old local observation', '[]', NULL, '2026-01-01');
  `);
  database.close();
  const backend = await createBackend(root, () => {}, { copilot });
  cleanup(() => backend.close());
  await connect();
  const list = await backend.request({ path: "/__grounds/service-chat/sessions?serviceName=fixture-service", method: "GET" });
  assert.equal(JSON.parse(list.body).sessions[0].readOnly, true);
  const messages = await backend.request({ path: "/__grounds/service-chat/sessions/legacy/messages", method: "GET" });
  assert.equal(JSON.parse(messages.body).messages[0].content, "Old local observation");
  const rejected = await backend.request({
    path: "/__grounds/service-chat/sessions/legacy/messages", method: "POST",
    body: JSON.stringify({ question: "Use the old history" }),
  });
  assert.equal(rejected.status, 409);
  assert.equal(state.prompts.length, 0);
});

function architectureGraph(displayName = "Fixture Service") {
  return {
    title: `${displayName} system overview`, summary: "A bounded logical architecture draft.",
    nodes: [
      { id: "service", label: displayName, kind: "service", description: "Focal service.", evidenceSourceIds: [1] },
      { id: "queue", label: "Work queue", kind: "queue", description: "Declared downstream work queue.", evidenceSourceIds: [1] },
    ],
    edges: [{ id: "publish", source: "service", target: "queue", label: "Publishes work", evidenceSourceIds: [1] }],
    uncertainties: ["Protocol and deployed network boundaries are not established."],
  };
}

async function architectureFixture(t) {
  const current = await fixture(t);
  const { root, copilot, state, cleanup } = current;
  await initializeData(root, resources);
  const repository = path.join(root, "repository");
  await fs.mkdir(path.join(repository, "component"), { recursive: true });
  await fs.mkdir(path.join(repository, "other"));
  await exec("git", ["init", "--quiet", repository]);
  await fs.writeFile(path.join(repository, "component", "Topology.cs"), "HttpClient publishes to QueueClient; // architecture evidence\n");
  await fs.writeFile(path.join(repository, "other", "Topology.cs"), "HttpClient unrelated service architecture\n");
  await fs.writeFile(path.join(repository, "component", "secrets.json"), "QueueClient credential fixture\n");
  await exec("git", ["-C", repository, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "."]);
  await exec("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Fixture"]);
  const { record } = createServiceRecord({
    serviceName: "fixture-service", displayName: "Fixture Service", description: "Architecture test service",
    repositoryUrl: "https://github.com/grounds-fixture/service", defaultBranch: "main",
  });
  record.dependencies = [{ service: "Work queue", direction: "downstream", purpose: "Publishes work" }];
  Object.assign(record.repositories[0], { localPath: repository, checkoutStatus: "available", paths: ["component"] });
  await fs.writeFile(path.join(root, "services", "fixture.json"), JSON.stringify(record));
  await fs.writeFile(path.join(root, "services", "other.json"), JSON.stringify({
    ...record, service: { ...record.service, name: "other-service", displayName: "Other Service" },
    repositories: record.repositories.map((entry) => ({ ...entry, paths: ["other"] })),
  }));
  let backend = await createBackend(root, () => {}, { copilot });
  cleanup(() => backend.close());
  async function request(route, method = "GET", body) {
    const result = await backend.request({
      path: `/__grounds/service-chat/${route}`, method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, ...JSON.parse(result.body) };
  }
  async function finished() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await request("architecture/fixture-service");
      if (!["collecting", "generating", "cancelling"].includes(result.job?.status)) return result;
      await delay(15);
    }
    throw new Error("Architecture job did not finish within the fixture deadline.");
  }
  state.send = async () => ({ data: { content: JSON.stringify(architectureGraph()) } });
  return {
    ...current, request, finished,
    async reopen() {
      await backend.close();
      backend = await createBackend(root, () => {}, { copilot });
    },
    close: () => backend.close(),
  };
}

test("architecture graphs reject unsupported citations, duplicate IDs, and unresolved edges", () => {
  const evidence = { sources: [{ id: 1 }] };
  const graph = architectureGraph();
  assert.equal(parseArchitecture(JSON.stringify(graph), evidence, "Fixture Service").nodes.length, 2);
  const reject = (value) => assert.throws(() => parseArchitecture(JSON.stringify(value), evidence, "Fixture Service"), /architecture graph|unresolved components/);
  reject({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] });
  reject({ ...graph, edges: [{ ...graph.edges[0], target: "missing" }] });
  reject({ ...graph, edges: [{ ...graph.edges[0], target: "service" }] });
  reject({ ...graph, nodes: [{ ...graph.nodes[0], evidenceSourceIds: [999] }] });
  reject({ ...graph, nodes: [{ ...graph.nodes[0], label: "Another service" }] });
  reject({ ...graph, nodes: [{ ...graph.nodes[0], evidenceSourceIds: [] }] });
});

test("on-demand architecture persists scoped evidence and review, and is included only in its operator's service chat", async (t) => {
  const current = await architectureFixture(t);
  const { request, finished, state, connect, copilot } = current;
  assert.equal((await request("architecture/fixture-service")).status, 401);
  await connect();
  assert.equal((await request("architecture/fixture-service")).flow, undefined);
  assert.equal(state.prompts.length, 0, "Opening an architecture workspace never generates a flow.");
  assert.equal((await request("architecture/fixture-service", "POST")).status, 202);
  let result = await finished();
  assert.equal(result.job.status, "completed", JSON.stringify(result));
  const flow = result.flow;
  assert.equal(flow.status, "draft");
  assert.equal(flow.repositories[0].revision.length, 40);
  assert.deepEqual(flow.codeEvidence.map((entry) => entry.path), ["component/Topology.cs"]);
  assert.equal(state.prompts[0].task, "architecture-flow");
  assert.deepEqual(state.prompts[0].evidence.code.map((entry) => entry.path), ["component/Topology.cs"]);
  assert.equal((await request("architecture/fixture-service", "PUT", { flowId: "stale" })).status, 409);
  result = await request("architecture/fixture-service", "PUT", { flowId: flow.id });
  assert.equal(result.flow.status, "reviewed");
  await current.reopen();
  assert.equal((await request("architecture/fixture-service")).flow.status, "reviewed");
  assert.equal(state.prompts.length, 1);
  state.send = async () => ({ data: { content: "Architecture-aware answer. [1]" } });
  let session = (await request("sessions", "POST", { serviceName: "fixture-service" })).session;
  assert.equal((await request(`sessions/${session.id}/messages`, "POST", { question: "Explain the architecture" })).status, 201);
  const architecture = state.prompts.at(-1).evidence.architecture;
  assert.equal(architecture.id, flow.id);
  assert.equal(architecture.status, "reviewed");
  assert.match(architecture.limitation, /not live deployed topology/);
  const ids = new Set(state.prompts.at(-1).sources.map((source) => source.id));
  assert.ok(architecture.nodes.every((node) => node.evidenceSourceIds.every((id) => ids.has(id))));
  session = (await request("sessions", "POST", { serviceName: "other-service" })).session;
  assert.equal((await request(`sessions/${session.id}/messages`, "POST", { question: "Explain the architecture" })).status, 201);
  assert.equal(state.prompts.at(-1).evidence.architecture, undefined);
  await copilot.logout();
  state.login = "operator-b";
  await connect();
  assert.equal((await request("architecture/fixture-service")).flow, undefined);
  session = (await request("sessions", "POST", { serviceName: "fixture-service" })).session;
  assert.equal((await request(`sessions/${session.id}/messages`, "POST", { question: "Explain the architecture" })).status, 201);
  assert.equal(state.prompts.at(-1).evidence.architecture, undefined);
  await copilot.logout();
  state.login = "operator-a";
  await connect();
  assert.equal((await request("architecture/fixture-service")).flow.id, flow.id);
  const servicePath = path.join(current.root, "services", "fixture.json");
  const service = JSON.parse(await fs.readFile(servicePath, "utf8"));
  service.service.description = "Changed service configuration";
  await fs.writeFile(servicePath, JSON.stringify(service));
  assert.equal((await request("architecture/fixture-service")).flow.catalogChanged, true);
  assert.equal((await request("architecture/fixture-service", "PUT", { flowId: flow.id })).status, 409);
});

test("cancelling during the pre-send account check prevents model dispatch", async (t) => {
  const { copilot, connect, state } = await fixture(t);
  await connect();
  let release;
  let ready;
  const paused = new Promise((resolve) => { ready = resolve; });
  const investigation = copilot.investigate("cancel-before-send", async (_actor, generate) => {
    state.getStatus = async (result) => {
      state.getStatus = undefined;
      ready();
      await new Promise((resolve) => { release = resolve; });
      return result;
    };
    return generate(JSON.stringify({ task: "architecture-flow" }));
  });
  await paused;
  await copilot.cancelInvestigation("cancel-before-send");
  release();
  await assert.rejects(investigation, /cancelled/);
  assert.equal(state.prompts.length, 0);
  assert.equal((await copilot.status()).authenticated, true);
});

test("failed, cancelled, and interrupted architecture generation preserve the previous saved flow", async (t) => {
  const current = await architectureFixture(t);
  const { request, finished, state, connect, copilot } = current;
  await connect();
  await request("architecture/fixture-service", "POST");
  const saved = (await finished()).flow;
  state.send = async () => ({ data: { content: "Not a valid graph" } });
  await request("architecture/fixture-service", "POST");
  let result = await finished();
  assert.equal(result.job.status, "failed");
  assert.match(result.job.error, /valid architecture JSON/);
  assert.equal(result.flow.id, saved.id);
  async function pendingGeneration() {
    let started;
    let release;
    const ready = new Promise((resolve) => { started = resolve; });
    state.send = () => {
      started();
      return new Promise((resolve) => { release = resolve; });
    };
    state.abort = () => release?.({ data: { content: JSON.stringify(architectureGraph()) } });
    await request("architecture/fixture-service", "POST");
    await ready;
  }
  await pendingGeneration();
  assert.equal((await request("architecture/fixture-service", "POST")).status, 409);
  await assert.rejects(copilot.logout(), /409|Finish|investigation|running/i);
  assert.equal((await request("architecture/fixture-service/cancel", "POST")).status, 200);
  result = await finished();
  assert.equal(result.job.status, "cancelled");
  assert.equal(result.flow.id, saved.id);
  await pendingGeneration();
  await current.reopen();
  assert.equal((await request("architecture/fixture-service")).flow.id, saved.id);
  assert.equal((await copilot.status()).authenticated, true);
});

test("architecture is not persisted when native conversation cleanup fails", async (t) => {
  const current = await architectureFixture(t);
  const { root, request, finished, state, connect, copilot } = current;
  await connect();
  await request("architecture/fixture-service", "POST");
  const saved = (await finished()).flow;
  state.failCleanup = true;
  await request("architecture/fixture-service", "POST");
  const deadline = Date.now() + 20_000;
  while ((await copilot.status()).authenticated && Date.now() < deadline) await delay(15);
  assert.equal((await copilot.status()).restartRequired, true);
  await current.close();
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path.join(root, ".grounds", "grounds.db"), { readOnly: true });
  try {
    const row = database.prepare("SELECT document FROM architecture_flows WHERE service_name = ?").get("fixture-service");
    assert.equal(JSON.parse(row.document).id, saved.id);
  } finally { database.close(); }
});
