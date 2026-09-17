/**
 * Placeholder home page — phase 00.
 *
 * Phase 10 replaces this with the upload flow, the clause reader and the findings view. Until
 * then it says exactly what exists, which is also the AI disclosure the EU AI Act Article 50(1)
 * requires *before* the first interaction rather than in a footer afterwards.
 *
 * The heading level starts at `h1` and the `<main>` landmark lives in the layout, so the document
 * outline is already correct before there is anything in it.
 */
export default function HomePage() {
  return (
    <article style={{ maxWidth: '42rem', margin: '0 auto', padding: '2rem 1rem' }}>
      <h1>LexMind</h1>

      <p>
        LexMind reads a residential lease and explains what it says in plain English: what you owe
        and when, what the landlord may do, which clauses are one-sided, and what the law where you
        live has to say about them.
      </p>

      <p>
        <strong>LexMind gives legal information, not legal advice.</strong> It will not tell you
        whether to sign, predict what a court will do, or draft a document for you. It will help you
        prepare for a conversation with someone who can.
      </p>

      <h2>Run it</h2>

      <ol>
        <li>
          Install dependencies: <code>pnpm install</code>
        </li>
        <li>
          Optional — copy <code>.env.example</code> to <code>.env</code> and set{' '}
          <code>GEMINI_API_KEY</code> for AI-written summaries and explanations. Without a key,
          LexMind still reports every rule-based finding, fully offline.
        </li>
        <li>
          Start the dev server: <code>pnpm dev</code>, then open <code>http://localhost:3000</code>
        </li>
      </ol>

      <h2>Use it</h2>

      <h3>From the command line</h3>
      <p>
        The engine lives in <code>packages/core</code> and is usable today from the terminal:
      </p>
      <pre>
        <code>pnpm lexmind analyse ./lease.pdf</code>
      </pre>
      <p>
        Add <code>--jurisdiction &lt;id&gt;</code> to declare a jurisdiction instead of inferring
        it, or <code>--json</code> for machine-readable output. Run <code>pnpm lexmind --help</code>{' '}
        for the full command reference.
      </p>

      <h3>From the browser</h3>
      <p>
        <a href="/try">Try the engine test page</a> — paste lease text or upload a <code>.txt</code>
        , <code>.pdf</code>, or <code>.docx</code> file, pick a jurisdiction (or let it
        auto-detect), and submit to see the same findings the CLI produces, rendered as a list of
        clauses with their severity, citations, and quoted anchors back into your document. It is a
        scratch page for exercising the engine, not the finished interface.
      </p>

      <p>
        Everything the interface does is reproducible from the CLI command above, which is the
        point: nothing in this product depends on a browser to be correct.
      </p>
    </article>
  );
}
