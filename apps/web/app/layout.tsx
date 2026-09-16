import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The root layout — a phase 00 placeholder. Phase 10 builds the real interface on top of it.
 *
 * Three things are here from the first commit because they are cheap now and expensive to
 * retrofit:
 *
 *  - **`lang="en"`** (WCAG 3.1.1 Language of Page). Without it a screen reader announces English
 *    prose with whatever voice the user's locale last selected.
 *  - **A skip link** (WCAG 2.4.1 Bypass Blocks) as the first focusable element, visible on focus.
 *    Once phase 10 adds a nav and a clause list, a keyboard user without this has to tab through
 *    the entire document outline to reach the content.
 *  - **`<main id="main">` in the layout, not the page**, so the skip target exists on every route
 *    by construction rather than by every page remembering to add one.
 *
 * `user-scalable` is left at its default: blocking zoom fails WCAG 1.4.4 Resize Text.
 */

export const metadata: Metadata = {
  title: {
    default: 'LexMind — understand your lease',
    template: '%s · LexMind',
  },
  description:
    'LexMind explains what a residential lease says, in plain English, with every claim checked against your own document. Legal information, not legal advice.',
  applicationName: 'LexMind',
  // The demo handles uploaded leases. No search engine should be indexing a deployment of it.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Respect the reader's system theme rather than imposing one.
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Phase 10 replaces this with the real stylesheet. Kept inline for now so the skip link
            behaves correctly (off-screen until focused) without a stylesheet that phase 10 would
            immediately throw away. */}
        <style>{`
          :root { color-scheme: light dark; }
          body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
          .skip-link {
            position: absolute;
            left: -9999px;
            top: 0;
            padding: 0.75rem 1rem;
            background: Canvas;
            color: LinkText;
          }
          .skip-link:focus-visible { left: 0; z-index: 100; }
          main:focus { outline: none; }
        `}</style>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {/* tabIndex -1 so the skip link actually moves focus, not just the scroll position. */}
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
