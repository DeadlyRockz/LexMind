import type { NextConfig } from 'next';

/**
 * Security headers, set at the edge rather than in a meta tag.
 *
 * **On CSP.** A nonce-based Content-Security-Policy forces every page to render dynamically and
 * is incompatible with Partial Prerendering, so the decision is deferred to phase 10 where the
 * real pages exist and the trade-off is concrete. Everything below is header-only and costs
 * nothing at render time, so it ships now.
 *
 * `frame-ancestors` is set via CSP because `X-Frame-Options` is not honoured by every modern
 * browser in the same way; both are sent, which is the documented belt-and-braces approach.
 */
const securityHeaders = [
  // A lease is uploaded here. Nothing about this app should ever be framed by another origin.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Content type is never guessed. Relevant the moment a user-supplied PDF is echoed back.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Document identifiers appear in URLs; they must not leak to any third party via Referer.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  // LexMind needs none of these. Denying them closes the surface rather than trusting it unused.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The server's framework and version are not information a visitor needs.
  poweredByHeader: false,

  // NOTE: `transpilePackages: ['@lexmind/core']` is deliberately absent. Turbopack — the default
  // bundler in Next 16 — already transpiles pnpm workspace packages, so adding it would be
  // cargo-culted configuration.

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
