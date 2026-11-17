import { EvidenceButton } from "../components";
import { questions, type EvidenceId } from "../scenario";

export function Troubleshoot({ answered, onAnswer, onEvidence }: {
  answered: string[];
  onAnswer: (id: string) => void;
  onEvidence: (id: EvidenceId) => void;
}) {
  return <>
    <section className="chat-disclosure">
      <span className="tag">Prepared walkthrough</span>
      <p>These are prewritten sample answers, not a live Copilot session. No prompt or service data is sent anywhere.</p>
    </section>
    <div className="troubleshoot-layout">
      <section className="panel question-panel">
        <p className="eyebrow">Service-scoped investigation</p><h2>Ask about Parcel Service</h2>
        <p className="muted">Choose a prepared question to see how Grounds brings context and cited evidence together.</p>
        <div className="question-list">
          {questions.map((question) => <button key={question.id} onClick={() => onAnswer(question.id)} disabled={answered.includes(question.id)}>
            <span>{question.question}</span><small>{answered.includes(question.id) ? "Added to investigation" : "Show sample answer ->"}</small>
          </button>)}
        </div>
        <div className="context-summary"><strong>Included sample context</strong><span>prod-east / v2.8.1</span><span>Architecture + deployment + source diff</span></div>
      </section>
      <section className="conversation" aria-label="Sample investigation" aria-live="polite" aria-relevant="additions">
        {!answered.length && <div className="panel conversation-empty"><span className="large-mark" aria-hidden="true">G</span><h2>Start with a useful question.</h2><p>Connect the observation, release, and processing path without losing the source of each claim.</p><span className="tag">Sample answers / cited evidence</span></div>}
        {answered.map((id) => {
          const question = questions.find((item) => item.id === id)!;
          return <article className="chat-exchange" key={id}>
            <div className="sample-question"><span>You / selected question</span><p>{question.question}</p></div>
            <div className="panel sample-answer">
              <p className="eyebrow">Grounds / prewritten sample</p><h2>{question.heading}</h2>
              {question.paragraphs.map((paragraph, index) => <p key={index}>{paragraph.text}{" "}
                {paragraph.citations.map((citation) => <EvidenceButton key={citation} id={citation} compact onSelect={onEvidence} />)}
              </p>)}
              <h3>Suggested checks</h3><ol>{question.nextSteps.map((step) => <li key={step}>{step}</li>)}</ol>
              <p className="answer-limitation">Hypothesis only. No live telemetry was queried and no action was taken.</p>
            </div>
          </article>;
        })}
      </section>
    </div>
  </>;
}
