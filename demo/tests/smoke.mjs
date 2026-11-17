import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, "dist-demo");
const prefix = "/vibehub/projects/grounds/";

test("the built demo is a self-contained, isolated static walkthrough", { timeout: 120_000 }, async (t) => {
  const assets = new Map();
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else assets.set(path.relative(output, file).split(path.sep).join("/"), await fs.readFile(file));
    }
  }
  await collect(output);
  assert.ok(assets.has("index.html"));
  assert.ok([...assets.keys()].every((name) => name === "index.html" || /^assets\/[\w-]+\.(js|css)$/.test(name)));
  assert.ok([...assets.values()].reduce((sum, content) => sum + content.length, 0) < 300_000_000);
  const html = assets.get("index.html").toString().replaceAll("&#39;", "'");
  assert.match(html, /worker-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /src="\.\/assets\//);

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "index.html" : "";
    const content = assets.get(relative);
    if (!content) {
      response.writeHead(404).end("Not found");
      return;
    }
    const mime = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : "text/html";
    response.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" }).end(content);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}${prefix}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const unexpectedRequests = [];
  const failures = [];
  await context.route("**/*", (route) => {
    const requestUrl = new URL(route.request().url());
    const relative = requestUrl.pathname.startsWith(prefix) ? requestUrl.pathname.slice(prefix.length) || "index.html" : "";
    if (requestUrl.origin !== origin || !assets.has(relative)) {
      unexpectedRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    window.demoBoundaryViolations = [];
    function forbidden(name) {
      return function () {
        window.demoBoundaryViolations.push(name);
        throw new Error(`Demo attempted forbidden runtime capability: ${name}`);
      };
    }
    window.fetch = forbidden("fetch");
    window.XMLHttpRequest = forbidden("XMLHttpRequest");
    window.WebSocket = forbidden("WebSocket");
    window.EventSource = forbidden("EventSource");
    window.Worker = forbidden("Worker");
    window.SharedWorker = forbidden("SharedWorker");
    Storage.prototype.getItem = forbidden("persistent storage read");
    Storage.prototype.setItem = forbidden("persistent storage");
    IDBFactory.prototype.open = forbidden("IndexedDB");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register = forbidden("service worker");
    document.addEventListener("securitypolicyviolation", (event) => {
      window.demoBoundaryViolations.push(`CSP: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
  page.on("worker", (worker) => failures.push(`Unexpected worker: ${worker.url()}`));
  async function checkBoundary() {
    assert.deepEqual(await page.evaluate(() => window.demoBoundaryViolations), []);
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(failures, []);
  }
  async function openStep(label, heading) {
    await page.getByRole("navigation", { name: "Demo walkthrough" }).getByRole("link", { name: label }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await checkBoundary();
  }

  await t.test("overview and evidence are honest, keyboard-accessible, and linked", async () => {
    await page.goto(url);
    await page.getByRole("heading", { name: "One service. The whole picture.", exact: true }).waitFor();
    assert.match(await page.locator(".demo-banner").innerText(), /Fictional data.*No live connections/);
    assert.equal(await page.getByRole("link", { name: "Get Grounds" }).getAttribute("href"), "https://github.com/andrewpethel/grounds");
    assert.equal(await page.evaluate(() => typeof window.groundsDesktop), "undefined");
    const trigger = page.getByRole("button", { name: "Read evidence 1: Environment observation", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: "Evidence details" });
    await panel.waitFor();
    assert.equal(await panel.evaluate((node) => document.activeElement === node), true);
    assert.match(await panel.innerText(), /not live telemetry/);
    await trigger.click();
    assert.equal(await panel.evaluate((node) => document.activeElement === node), true);
    await panel.getByRole("button", { name: "Close evidence" }).click();
    assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
    await checkBoundary();
  });

  await t.test("architecture components and relationships expose their evidence without workers", async () => {
    await openStep("Architecture", "See how the pieces connect.");
    await page.getByRole("button", { name: "Datastore Tracking store Sample component", exact: true }).click();
    assert.match(await page.getByRole("region", { name: "Selected architecture component or relationship" }).innerText(), /Stores the latest parcel tracking state/);
    await page.getByRole("button", { name: /Shipment queue.*Parcel Worker.*Consume/ }).click();
    assert.match(await page.getByRole("region", { name: "Selected architecture component or relationship" }).innerText(), /AMQP/);
    await page.getByRole("button", { name: "Read evidence 4: Parcel processing flow", exact: true }).click();
    assert.match(await page.getByRole("region", { name: "Evidence details" }).innerText(), /not a verified deployment topology/);
    await page.getByRole("button", { name: "Close evidence" }).click();
    await checkBoundary();
  });

  await t.test("About Grounds explains individual flexibility without becoming a walkthrough step", async () => {
    const aboutLink = page.getByRole("navigation", { name: "Product information" }).getByRole("link", { name: "About Grounds" });
    await aboutLink.click();
    await page.getByRole("heading", { name: "Your services. Your context. Your Grounds.", exact: true }).waitFor();
    assert.equal(await aboutLink.getAttribute("aria-current"), "page");
    assert.equal(await page.title(), "Grounds demo | About Grounds");
    assert.equal(await page.getByRole("navigation", { name: "Demo walkthrough" }).getByRole("link").count(), 4);
    assert.equal(await page.getByRole("navigation", { name: "Demo walkthrough" }).locator('[aria-current="page"]').count(), 0);
    assert.equal(await page.getByRole("region", { name: "Sample evidence library" }).count(), 0);
    const content = await page.getByRole("main").innerText();
    assert.match(content, /personal workspace does not have to mean a single-service workspace/);
    assert.match(content, /matching service declarations across repositories/);
    assert.match(content, /distinct components in a shared repository/);
    assert.match(content, /not a new permission boundary/);
    assert.match(content, /selected service evidence are sent to that provider/);
    await page.getByRole("button", { name: "Explore the four-step demo" }).click();
    await page.getByRole("heading", { name: "One service. The whole picture.", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "Your services. Your context. Your Grounds.", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Your services. Your context. Your Grounds.", exact: true }).waitFor();
    if (process.env.GROUNDS_DEMO_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.GROUNDS_DEMO_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GROUNDS_DEMO_SCREENSHOT_DIR, "grounds-demo-about.png"), fullPage: true });
    }
    await checkBoundary();
  });

  await t.test("release selection and comparison stay consistent", async () => {
    await openStep("Deployment changes", "A release is more than a version.");
    const diff = page.getByLabel("Configuration changes between v2.8.0 and v2.8.1");
    assert.match(await diff.innerText(), /-.*"MaxConcurrentHandlers": 32/);
    assert.match(await diff.innerText(), /\+.*"MaxConcurrentHandlers": 8/);
    await page.getByRole("button", { name: /^v2\.8\.0 Succeeded/ }).click();
    await page.getByRole("button", { name: "Release details", exact: true }).click();
    assert.match(await page.locator(".comparison-panel").innerText(), /a31f902/);
    await page.getByRole("button", { name: /^v2\.8\.1 Succeeded/ }).click();
    assert.match(await page.locator(".comparison-panel").innerText(), /b7e2c91/);
    await page.getByRole("button", { name: "Configuration comparison", exact: true }).click();
    await checkBoundary();
  });

  await t.test("prepared troubleshooting answers cite evidence and survive navigation until reset", async () => {
    await openStep("Troubleshoot", "Less context switching. More understanding.");
    assert.match(await page.locator(".chat-disclosure").innerText(), /prewritten sample answers, not a live Copilot session/);
    assert.equal(await page.getByRole("textbox").count(), 0);
    for (const question of ["What changed before the queue delay?", "Which part of the service should I investigate?", "What should I check before a mitigation?"]) {
      await page.getByRole("button", { name: new RegExp(question.replace(/[?]/g, "\\?")) }).click();
    }
    assert.equal(await page.locator(".chat-exchange").count(), 3);
    assert.equal(await page.getByRole("button", { name: /Added to investigation/ }).count(), 3);
    await page.getByRole("heading", { name: "From scattered context to a focused investigation." }).waitFor();
    await page.locator(".sample-answer").first().getByRole("button", { name: "Read evidence 3: Worker configuration comparison" }).click();
    assert.match(await page.getByRole("region", { name: "Evidence details" }).innerText(), /not proof of the effective runtime configuration/);
    await page.getByRole("button", { name: "Close evidence" }).click();
    await page.getByRole("navigation", { name: "Product information" }).getByRole("link", { name: "About Grounds" }).click();
    await page.getByRole("heading", { name: "Your services. Your context. Your Grounds.", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "Less context switching. More understanding." }).waitFor();
    assert.equal(await page.locator(".chat-exchange").count(), 3);
    await openStep("Service overview", "One service. The whole picture.");
    await page.goBack();
    await page.getByRole("heading", { name: "Less context switching. More understanding." }).waitFor();
    assert.equal(await page.locator(".chat-exchange").count(), 3);
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.getByRole("heading", { name: "One service. The whole picture." }).waitFor();
    assert.match(await page.getByRole("status").innerText(), /Demo reset/);
    await openStep("Troubleshoot", "Less context switching. More understanding.");
    assert.equal(await page.locator(".chat-exchange").count(), 0);
    await checkBoundary();
  });

  await t.test("all views fit narrow screens, support themes, and reload at nested hash URLs", async () => {
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const step of ["about", "overview", "architecture", "deployments", "troubleshoot"]) {
        await page.goto(`${url}#/${step}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        const dimensions = await page.evaluate(() => ({
          viewport: window.innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        assert.ok(dimensions.content <= dimensions.viewport + 1, `${step} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
        if (width === 320 && step === "troubleshoot") {
          await page.getByRole("button", { name: /What changed before the queue delay/ }).click();
          await page.locator(".sample-answer").getByRole("button", { name: "Read evidence 3: Worker configuration comparison" }).click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Narrow evidence and answer layout overflows");
          await page.getByRole("button", { name: "Close evidence" }).click();
        }
        await checkBoundary();
      }
    }
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    assert.equal(await page.locator(".demo-shell").getAttribute("data-theme"), "dark");
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await page.reload();
    await page.getByRole("heading", { name: "Less context switching. More understanding." }).waitFor();
    assert.equal(await page.locator(".chat-exchange").count(), 0, "Reload must clear in-memory answers");
    await checkBoundary();
  });

  await t.test("unknown links have a recovery path and static assets are complete", async () => {
    await page.goto(`${url}#/does-not-exist`);
    await page.getByRole("heading", { name: "This demo page does not exist." }).waitFor();
    await page.getByRole("button", { name: "Return to service overview" }).click();
    await page.getByRole("heading", { name: "One service. The whole picture." }).waitFor();
    for (const name of assets.keys()) {
      const response = await fetch(`${url}${name}`);
      assert.equal(response.status, 200, `Missing static asset: ${name}`);
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    if (process.env.GROUNDS_DEMO_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.GROUNDS_DEMO_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GROUNDS_DEMO_SCREENSHOT_DIR, "grounds-demo-overview.png"), fullPage: true });
    }
    await checkBoundary();
  });
});
