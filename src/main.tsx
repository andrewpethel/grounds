import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, initialColorMode, initialHighContrast } from "./App";
import "./styles.css";
import { initializeDesktopData } from "./data";
import { installDesktopTransport, type DesktopSnapshot } from "./desktop";
import { DesktopDiscovery, DesktopOnboarding } from "./DesktopOnboarding";
import { PipelineDiscoveryProvider } from "./PipelineDiscovery";

function DesktopApp() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.groundsDesktop!.onDataChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!document.querySelector(".desktop-onboarding")) window.location.reload();
      }, 500);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    window.groundsDesktop!.snapshot().then((value) => {
      if (cancelled) return;
      initializeDesktopData(value);
      setSnapshot(value);
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, []);
  if (error) return <main className="desktop-onboarding"><h1>Grounds could not load your workspace</h1><p role="alert">{error}</p><button onClick={() => window.location.reload()}>Retry</button></main>;
  if (!snapshot) return <main className="desktop-onboarding" role="status">Loading your workspace...</main>;
  if (snapshot.catalogEntries.length === 0) {
    return <DesktopOnboarding />;
  }
  return <PipelineDiscoveryProvider initial={snapshot.pipelineDiscovery}>
    <App />{snapshot.pendingOnboarding && <DesktopDiscovery setup={snapshot.pendingOnboarding} />}
  </PipelineDiscoveryProvider>;
}

document.documentElement.dataset.theme = initialColorMode();
document.documentElement.dataset.contrast = initialHighContrast() ? "high" : "normal";
if (window.groundsDesktop) installDesktopTransport(window.groundsDesktop);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.groundsDesktop ? <DesktopApp /> : <App />}
  </StrictMode>,
);
