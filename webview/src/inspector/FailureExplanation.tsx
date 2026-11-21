import React, { useState } from "react";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { stripAnsi } from "../utils/log-format";

export interface FailureExplanationSummary {
  mode: "model" | "fallback";
  availability: string;
  summary?: string;
  confidence?: "high" | "medium" | "low";
  failedStep?: string;
  errorLine?: { text: string; line?: number };
  model?: { id: string; name: string };
  observedFacts: string[];
  likelyExplanations: string[];
  suggestedNextSteps: string[];
  limitations: string[];
}

/** Renders `code` spans for backtick-delimited segments; everything else stays plain text. */
export function InlineText({ text }: { text: string }): React.JSX.Element {
  const parts = text.replace(/\*\*(.+?)\*\*/g, "$1").split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="ad-explain__code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

const AVAILABILITY_NOTE: Record<string, string> = {
  no_model: "No Copilot model is available, so this is a summary built from the run evidence.",
  consent_denied: "Copilot model access was declined, so this is a summary built from the run evidence.",
  model_error: "The Copilot model request failed, so this is a summary built from the run evidence.",
};

/** Text suitable for the log search box: drops timestamps / workflow command prefixes. */
export function errorLineSearchText(text: string): string {
  return stripAnsi(text)
    .replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
    .replace(/^##\[(error|warning)\]\s*/i, "")
    .replace(/^│\s*/, "")
    .trim()
    .slice(0, 60);
}

export function FailureExplanation({
  explanation,
  onShowInLog,
  onContinueInChat,
  onDismiss,
}: {
  explanation: FailureExplanationSummary;
  onShowInLog?: ((text: string) => void) | undefined;
  onContinueInChat?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const headline = explanation.summary ?? explanation.likelyExplanations[0] ?? "The job failed.";
  const confidence = explanation.mode === "model" ? explanation.confidence ?? "medium" : undefined;
  const actions = explanation.suggestedNextSteps.slice(0, 3);
  const otherCauses = explanation.likelyExplanations.filter((item) => item !== headline);
  const fallbackNote = explanation.mode === "fallback" ? AVAILABILITY_NOTE[explanation.availability] : undefined;
  const hasDetails =
    otherCauses.length > 0 || explanation.observedFacts.length > 0 || explanation.limitations.length > 0;

  return (
    <section aria-label="Failure explanation" className="ad-card ad-explain">
      <header className="ad-explain__head">
        <Icon name={explanation.mode === "model" ? "sparkle" : "info"} size={14} />
        <span className="ad-explain__eyebrow">Why it failed</span>
        {confidence ? (
          <span className={`ad-explain__badge ad-explain__badge--${confidence}`}>{`${confidence} confidence`}</span>
        ) : null}
        <span className="ad-toolbar__spacer" />
        {onDismiss ? (
          <Button variant="ghost" icon="close" title="Dismiss explanation" onClick={onDismiss} />
        ) : null}
      </header>

      <p className="ad-explain__summary">
        <InlineText text={headline} />
      </p>

      {explanation.failedStep || explanation.errorLine ? (
        <div className="ad-explain__evidence">
          {explanation.failedStep ? (
            <span className="ad-caption ad-muted">
              <Icon name="error" size={12} tone="failure" /> {explanation.failedStep}
            </span>
          ) : null}
          {explanation.errorLine ? (
            <button
              type="button"
              className="ad-explain__errline"
              title={onShowInLog ? "Find this line in the job log" : undefined}
              disabled={!onShowInLog}
              onClick={() => onShowInLog?.(errorLineSearchText(explanation.errorLine!.text))}
            >
              {explanation.errorLine.line !== undefined ? (
                <span className="ad-explain__lineno">{`L${explanation.errorLine.line}`}</span>
              ) : null}
              <span className="ad-explain__errtext">{stripAnsi(explanation.errorLine.text)}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {actions.length > 0 ? (
        <>
          <h5 className="ad-explain__label">What to do</h5>
          <ol className="ad-explain__actions">
            {actions.map((item, index) => (
              <li key={index}>
                <InlineText text={item} />
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {fallbackNote ? <p className="ad-caption ad-muted">{fallbackNote}</p> : null}

      {hasDetails ? (
        <div className="ad-explain__details">
          <button
            type="button"
            className="ad-explain__toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <Icon name={detailsOpen ? "chevron-down" : "chevron-right"} size={12} />
            Details
          </button>
          {detailsOpen ? (
            <div className="ad-caption ad-explain__detail-body">
              {otherCauses.length > 0 ? (
                <>
                  <strong>Other possible causes</strong>
                  <ul>
                    {otherCauses.map((item, idx) => (
                      <li key={idx}>
                        <InlineText text={item} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {explanation.observedFacts.length > 0 ? (
                <>
                  <strong>Observed facts</strong>
                  <ul>
                    {explanation.observedFacts.map((item, idx) => (
                      <li key={idx}>
                        <InlineText text={item} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {explanation.limitations.length > 0 ? (
                <>
                  <strong>Limitations</strong>
                  <ul>
                    {explanation.limitations.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="ad-explain__foot ad-caption ad-muted">
        <span>{explanation.model ? `Explained by ${explanation.model.name}` : explanation.mode === "model" ? "Explained by Copilot" : "Evidence summary"}</span>
        <span className="ad-toolbar__spacer" />
        {onContinueInChat ? (
          <button type="button" className="ad-explain__link" onClick={onContinueInChat}>
            Continue in Copilot Chat →
          </button>
        ) : null}
      </footer>
    </section>
  );
}
