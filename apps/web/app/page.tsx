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

      <h2>Not built yet</h2>

      <p>
        This page is a placeholder. The engine lives in <code>packages/core</code> and is usable
        today from the command line:
      </p>

      <pre>
        <code>pnpm lexmind analyse ./lease.pdf</code>
      </pre>

      <p>
        Everything the interface will do is reproducible from that command, which is the point:
        nothing in this product depends on a browser to be correct.
      </p>
    </article>
  );
}
