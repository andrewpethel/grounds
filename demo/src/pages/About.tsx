export function About({ onStart }: { onStart: () => void }) {
  return <>
    <div className="breadcrumb">Grounds <span>/</span> About</div>
    <div className="page-heading">
      <div>
        <p className="eyebrow">About Grounds</p>
        <h1>Your services. Your context. Your Grounds.</h1>
        <p>A personal service operations workspace that adapts to the slice of the system you actually work on.</p>
      </div>
      <span className="tag">Local workspace / Windows</span>
    </div>

    <section className="intro-card about-hero" aria-labelledby="about-purpose">
      <div>
        <p className="eyebrow">A focused lens on a connected system</p>
        <h2 id="about-purpose">Bring your work into focus. Not the whole organization.</h2>
        <p>Service context is scattered across repositories, deployment tools, architecture notes, and investigation history. Grounds brings those threads into a service-scoped workspace, so you can spend less time rebuilding context and more time understanding what matters.</p>
        <p>You choose the repositories and services relevant to you. Start with one service, bring in several, or revisit your selection as your responsibilities change. A personal workspace does not have to mean a single-service workspace.</p>
        <button className="primary-button" onClick={onStart}>Explore the four-step demo <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div className="scope-map" aria-label="How an individual workspace is scoped">
        <strong>Built around your scope</strong>
        <ol>
          <li><span>01</span><div><strong>Your repositories</strong><small>Choose the local source context.</small></div></li>
          <li><span>02</span><div><strong>Your services</strong><small>Select the components you work on.</small></div></li>
          <li><span>03</span><div><strong>Your investigation</strong><small>Focus on a service and its evidence.</small></div></li>
        </ol>
      </div>
    </section>

    <section className="about-section" aria-labelledby="about-flexibility">
      <p className="eyebrow">Individual in scope. Flexible in use.</p>
      <h2 id="about-flexibility">The same workspace. Different ways to work.</h2>
      <p className="muted">These are example workflows, not separate editions or fixed roles.</p>
      <div className="about-card-grid">
        <article className="panel">
          <span className="tag">On-call engineer</span>
          <h3>Go deep on one service.</h3>
          <p>Follow its processing path, compare releases, and investigate a selected environment without starting from a blank chat or a collection of unrelated tabs.</p>
        </article>
        <article className="panel">
          <span className="tag">Service owner</span>
          <h3>Bring a service's repositories together.</h3>
          <p>Connect matching service declarations across repositories. Source, deployment configuration, and supporting context can belong to the same named service without living in the same repository.</p>
        </article>
        <article className="panel">
          <span className="tag">Cross-service contributor</span>
          <h3>Keep your working set in view.</h3>
          <p>Select several relevant services, including distinct components in a shared repository. Your working scope need not mirror a repository boundary or an entire organizational service registration.</p>
        </article>
      </div>
    </section>

    <section className="about-section" aria-labelledby="about-objectives">
      <h2 id="about-objectives">What Grounds is built to improve</h2>
      <div className="about-card-grid">
        <article className="panel"><p className="eyebrow">Less context switching</p><h3>Start with the service, not the tool.</h3><p>Bring repository context, deployment history, and saved logical architecture into the same operator workflow. Keep links to the underlying sources rather than replacing their systems of record.</p></article>
        <article className="panel"><p className="eyebrow">More useful context</p><h3>Make the working set explicit.</h3><p>Repository manifests describe service identities, source paths, and pipeline or deployment associations. Your workspace selection determines which declared services you bring into view.</p></article>
        <article className="panel"><p className="eyebrow">Better-grounded investigation</p><h3>Keep the evidence attached.</h3><p>Use service-scoped troubleshooting and inspect the supplied sources, saved flows, and captured observations. Treat explanations as hypotheses to verify, not automatic root-cause verdicts.</p></article>
      </div>
    </section>

    <section className="callout">
      <strong>Your scope is a lens, not a new permission boundary.</strong>
      <p>Selecting a service does not grant access or establish ownership. Grounds uses your existing access and supported integrations. It is not a live telemetry platform, a verified enterprise inventory, or an autonomous operator that edits code or deploys fixes.</p>
    </section>

    <section className="about-section" aria-labelledby="about-get-started">
      <h2 id="about-get-started">Try the story here. Bring your own context in the real app.</h2>
      <div className="content-grid">
        <article className="panel">
          <p className="eyebrow">This browser demo</p>
          <h3>One fictional service. No setup.</h3>
          <p>Explore a prepared investigation using sample architecture, releases, and cited answers. There is no sign-in, repository access, live AI, database, or connection to your services.</p>
          <button className="text-button" onClick={onStart}>Start with the service overview &rarr;</button>
        </article>
        <article className="panel">
          <p className="eyebrow">The Windows workspace</p>
          <h3>Your selection. Your locally saved context.</h3>
          <p>Choose a repositories folder, define or discover services through <code>GroundsManifest.json</code>, and select the services to open. Connect supported integrations as needed; Azure DevOps features use Azure CLI authentication.</p>
          <p>GitHub Copilot troubleshooting requires a separate explicit connection and entitlement. Questions, recent conversation, and selected service evidence are sent to that provider. Use only data approved for it; local storage does not mean every feature runs offline.</p>
          <a className="text-button" href="https://github.com/andrewpethel/grounds#readme" target="_blank" rel="noreferrer">Read setup instructions on GitHub &#8599;</a>
        </article>
      </div>
    </section>
  </>;
}
