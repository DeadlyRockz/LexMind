'use client';

/**
 * Dev-only scratch page for exercising `analyse()` from a browser, live AI included.
 *
 * Not the phase 10 deliverable — see the note in `app/page.tsx` and `app/api/analyse/route.ts`.
 * No `<mark>` highlighting, no accessible highlight index, no axe/Playwright coverage: this is a
 * form and a results dump, built to unblock manual testing before that phase is built properly.
 */

import { type FormEvent, useId, useState } from 'react';

const JURISDICTION_OPTIONS = [
  { id: '', label: 'Auto-detect from the document' },
  { id: 'IN-MTA', label: 'India — Model Tenancy Act 2021' },
  { id: 'IN-STATE', label: 'India — state rent law (general)' },
  { id: 'US-URLTA', label: 'United States — URLTA' },
  { id: 'US-CA', label: 'United States — California' },
  { id: 'US-NY', label: 'United States — New York' },
  { id: 'GB-ENG', label: 'England — assured shorthold tenancy' },
  { id: 'unknown', label: 'Unknown / not sure' },
] as const;

interface Citation {
  readonly authority: string;
  readonly provision: string;
  readonly summary: string;
}

interface Anchor {
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
}

interface Finding {
  readonly id: string;
  readonly title: string;
  readonly whatItSays: string;
  readonly whyItMatters: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly citations: readonly Citation[];
  readonly anchors: readonly Anchor[];
}

interface AnalyseResult {
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
  readonly modelLabel: string;
  readonly jurisdiction: { readonly id: string; readonly confidence: string };
  readonly obligationBalance: {
    readonly tenant: number;
    readonly landlord: number;
    readonly ratio: number | null;
  };
  readonly summary: { readonly sections: readonly { readonly text: string }[] } | null;
  readonly usage: {
    readonly total: { readonly promptTokens: number; readonly outputTokens: number };
    readonly calls: number;
  };
}

interface AnalyseResponse {
  readonly modelReason: string;
  readonly offline: boolean;
  readonly sourceKind: string;
  readonly pageCount: number;
  readonly result: AnalyseResult;
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export default function TryPage() {
  const textareaId = useId();
  const fileId = useId();
  const jurisdictionId = useId();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyseResponse | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setPending(true);
    setError(null);
    setData(null);

    try {
      const response = await fetch('/api/analyse', { method: 'POST', body: form });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'Analysis failed.';
        setError(message);
      } else {
        setData(payload as AnalyseResponse);
      }
    } catch {
      setError('Could not reach the analysis engine.');
    } finally {
      setPending(false);
    }
  }

  return (
    <article style={{ maxWidth: '48rem', margin: '0 auto', padding: '2rem 1rem' }}>
      <h1>LexMind — engine test page</h1>
      <p>
        Scratch page, not the real interface. Paste a lease (or pick a file), pick a jurisdiction,
        and see what <code>analyse()</code> returns — live AI if a key is configured, offline
        rule-based analysis otherwise.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBlockEnd: '1rem' }}>
          <label htmlFor={textareaId}>Lease text</label>
          <br />
          <textarea
            id={textareaId}
            name="text"
            rows={12}
            style={{ width: '100%', fontFamily: 'monospace' }}
            placeholder="Paste the lease text here…"
          />
        </div>

        <div style={{ marginBlockEnd: '1rem' }}>
          <label htmlFor={fileId}>…or a file (.txt, .pdf, .docx)</label>
          <br />
          <input id={fileId} name="file" type="file" accept=".txt,.pdf,.docx" />
        </div>

        <div style={{ marginBlockEnd: '1rem' }}>
          <label htmlFor={jurisdictionId}>Jurisdiction</label>
          <br />
          <select id={jurisdictionId} name="jurisdiction" defaultValue="">
            {JURISDICTION_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" disabled={pending}>
          {pending ? 'Analysing…' : 'Analyse'}
        </button>
      </form>

      <div role="status" aria-live="polite" style={{ marginBlockStart: '1rem' }}>
        {pending ? 'Analysing…' : null}
        {error !== null ? `Error: ${error}` : null}
        {data !== null
          ? `Analysis complete. ${data.result.findings.length} finding${data.result.findings.length === 1 ? '' : 's'}.`
          : null}
      </div>

      {data !== null ? (
        <section style={{ marginBlockStart: '1.5rem' }}>
          <h2>Run info</h2>
          <ul>
            <li>
              Model: {data.result.modelLabel} — {data.modelReason}
            </li>
            <li>
              Jurisdiction resolved: {data.result.jurisdiction.id} (
              {data.result.jurisdiction.confidence})
            </li>
            <li>
              Source: {data.sourceKind}, {data.pageCount} page(s)
            </li>
            <li>
              Tokens: {data.result.usage.total.promptTokens} in /{' '}
              {data.result.usage.total.outputTokens} out, {data.result.usage.calls} call(s)
            </li>
            <li>
              Obligation balance — tenant: {data.result.obligationBalance.tenant}, landlord:{' '}
              {data.result.obligationBalance.landlord}
            </li>
          </ul>

          {data.result.notes.length > 0 ? (
            <>
              <h3>Notes</h3>
              <ul>
                {data.result.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          ) : null}

          {data.result.summary !== null ? (
            <>
              <h2>Summary</h2>
              {data.result.summary.sections.map((section) => (
                <p key={section.text}>{section.text}</p>
              ))}
            </>
          ) : null}

          <h2>Findings ({data.result.findings.length})</h2>
          {data.result.findings.map((finding) => (
            <article
              key={finding.id}
              style={{
                border: '1px solid CanvasText',
                borderRadius: '0.5rem',
                padding: '1rem',
                marginBlockEnd: '1rem',
              }}
            >
              <h3>
                {SEVERITY_LABEL[finding.severity]} — {finding.title}
              </h3>
              <p>
                <strong>Says:</strong> {finding.whatItSays}
              </p>
              <p>
                <strong>Why it matters:</strong> {finding.whyItMatters}
              </p>
              {finding.citations.length > 0 ? (
                <p>
                  <strong>Cited:</strong>{' '}
                  {finding.citations
                    .map((citation) => `${citation.authority} ${citation.provision}`)
                    .join('; ')}
                </p>
              ) : null}
              {finding.anchors.map((anchor) => (
                <blockquote key={`${anchor.charStart}-${anchor.charEnd}`}>
                  “{anchor.quote}” (chars {anchor.charStart}–{anchor.charEnd})
                </blockquote>
              ))}
            </article>
          ))}
        </section>
      ) : null}
    </article>
  );
}
