import { useEffect, useRef, useState } from "react";
import { EvidencePanel } from "./components";
import { evidence, evidenceIds, service, steps, type EvidenceId, type PageId } from "./scenario";
import { Overview } from "./pages/Overview";
import { Architecture } from "./pages/Architecture";
import { Deployments } from "./pages/Deployments";
import { Troubleshoot } from "./pages/Troubleshoot";
import { About } from "./pages/About";

function currentPage(): PageId | "about" | "not-found" {
  const hash = window.location.hash;
  if (!hash || hash === "#/" || hash === "#/overview") return "overview";
  if (hash === "#/about") return "about";
  return steps.find((step) => hash === `#/${step.id}`)?.id ?? "not-found";
}

export function DemoApp() {
  const [page, setPage] = useState(currentPage);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceId>();
  const [answered, setAnswered] = useState<string[]>([]);
  const [visited, setVisited] = useState<PageId[]>(() => {
    const initial = currentPage();
    return initial === "not-found" || initial === "about" ? [] : [initial];
  });
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState("");
  const main = useRef<HTMLElement>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function followNavigation() {
      const next = currentPage();
      setPage(next);
      setSelectedEvidence(undefined);
      setNotice("");
      if (next !== "not-found" && next !== "about") setVisited((previous) => previous.includes(next) ? previous : [...previous, next]);
      main.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
    window.addEventListener("hashchange", followNavigation);
    return () => window.removeEventListener("hashchange", followNavigation);
  }, []);

  const stepIndex = steps.findIndex((step) => step.id === page);
  const step = steps[stepIndex];
  const pageLabel = page === "about" ? "About Grounds" : step?.label ?? "Page not found";

  useEffect(() => {
    document.title = `Grounds demo | ${pageLabel}`;
  }, [pageLabel]);

  function navigate(next: PageId) {
    window.location.hash = `/${next}`;
  }
  function reset() {
    setAnswered([]);
    setSelectedEvidence(undefined);
    setVisited(["overview"]);
    setSession((previous) => previous + 1);
    setNotice("Demo reset. All sample interactions have been cleared.");
    if (currentPage() !== "overview") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/overview`);
      setPage("overview");
    }
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
  function showEvidence(id: EvidenceId) {
    evidenceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (selectedEvidence === id) document.getElementById("demo-evidence")?.focus();
    setSelectedEvidence(id);
  }
  function closeEvidence() {
    setSelectedEvidence(undefined);
    evidenceTrigger.current?.focus();
  }

  return <div className="demo-shell" data-theme={theme}>
    <a className="skip-link" href="#demo-main" onClick={(event) => {
      event.preventDefault();
      main.current?.focus();
    }}>Skip to content</a>
    <div className="demo-banner"><span><strong>Interactive demo</strong><span className="banner-divider">/</span>Fictional data <span aria-hidden="true">&middot;</span> No live connections</span><button onClick={reset}>Reset demo</button></div>
    <header className="demo-header">
      <a className="brand" href="#/overview" aria-label="Grounds demo home"><span className="brand-mark" aria-hidden="true">G</span><strong>Grounds</strong><span className="brand-caption">Service operations</span></a>
      <div className="header-actions">
        <button className="quiet-button theme-button" onClick={() => setTheme((previous) => previous === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "Dark theme" : "Light theme"}</button>
        <a className="repo-link" href="https://github.com/andrewpethel/grounds" target="_blank" rel="noreferrer">Get Grounds <span aria-hidden="true">&#8599;</span></a>
      </div>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <nav className="product-nav" aria-label="Product information">
          <a href="#/about" className={page === "about" ? "active" : ""} aria-current={page === "about" ? "page" : undefined}>
            <span className="step-number" aria-hidden="true">G</span>
            <span><strong>About Grounds</strong><small>Built around your scope</small></span>
          </a>
        </nav>
        <p className="eyebrow sidebar-label">Explore the workspace</p>
        <nav aria-label="Demo walkthrough">
          {steps.map((item, index) => <a key={item.id} href={`#/${item.id}`} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined}>
            <span className={`step-number ${visited.includes(item.id) ? "visited" : ""}`} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <span><strong>{item.label}</strong><small>{item.caption}</small></span>
          </a>)}
        </nav>
        <div className="sidebar-context"><span className="service-avatar" aria-hidden="true">P</span><strong>{service.name}</strong><small>{service.team}</small><span className="status warning">Investigation example</span></div>
        <div className="sidebar-footnote"><strong>Your workspace, connected.</strong><p>The full app works with your local repositories and authenticated service context. This demo does neither.</p></div>
      </aside>
      <main id="demo-main" ref={main} tabIndex={-1}>
        <div role="status" className={notice ? "reset-notice" : "visually-hidden"}>{notice}</div>
        {page === "about" ? <About onStart={() => navigate("overview")} /> : step ? <>
          <div className="breadcrumb">Workspace <span>/</span> {service.name} <span>/</span> {step.label}</div>
          <div className="page-heading"><div><p className="eyebrow">Step {stepIndex + 1} of {steps.length} / {step.label}</p><h1>{step.title}</h1><p>{service.description}</p></div><span className="tag snapshot-tag">Fictional snapshot / 12 Nov 2026</span></div>
          <div key={session}>
            {page === "overview" && <Overview navigate={navigate} onEvidence={showEvidence} />}
            {page === "architecture" && <Architecture onEvidence={showEvidence} />}
            {page === "deployments" && <Deployments onEvidence={showEvidence} />}
            {page === "troubleshoot" && <Troubleshoot answered={answered} onAnswer={(id) => setAnswered((previous) => previous.includes(id) ? previous : [...previous, id])} onEvidence={showEvidence} />}
          </div>
          {page === "troubleshoot" && answered.length === 3 && <section className="completion-card" role="status"><p className="eyebrow">Walkthrough complete</p><h2>From scattered context to a focused investigation.</h2><p>You connected a service, its processing path, a release change, and the evidence needed to investigate it. The real app brings your approved local service context into that workflow.</p><a className="primary-button" href="https://github.com/andrewpethel/grounds" target="_blank" rel="noreferrer">Explore Grounds on GitHub &#8599;</a></section>}
          <section className="evidence-library" aria-label="Sample evidence library"><strong>Follow the evidence</strong><div>{evidenceIds.map((id) => <button key={id} onClick={() => showEvidence(id)}>[{evidence[id].number}] {evidence[id].title}</button>)}</div></section>
          {selectedEvidence && <EvidencePanel key={selectedEvidence} id={selectedEvidence} onClose={closeEvidence} />}
          <footer className="walkthrough-footer">
            {stepIndex > 0 ? <button className="quiet-button" onClick={() => navigate(steps[stepIndex - 1].id)}>&larr; {steps[stepIndex - 1].label}</button> : <span>Explore freely, or follow the four steps.</span>}
            {stepIndex < steps.length - 1 ? <button className="primary-button" onClick={() => navigate(steps[stepIndex + 1].id)}>Next: {steps[stepIndex + 1].label} &rarr;</button> : <button className="quiet-button" onClick={reset}>Back to the beginning &uarr;</button>}
          </footer>
        </> : <section className="panel not-found"><p className="eyebrow">Grounds demo</p><h1>This demo page does not exist.</h1><p>Choose one of the four walkthrough steps to continue.</p><button className="primary-button" onClick={() => navigate("overview")}>Return to service overview</button></section>}
        <p className="app-footnote">Grounds / an operator workspace, not an autonomous operator. All services, releases, observations, and answers in this demo are fictional.</p>
      </main>
    </div>
  </div>;
}
