import {
  isValidIfscFormat,
  isValidLuhn,
  isValidNino,
  isValidNric,
  isValidPanFormat,
  isValidVerhoeff,
} from './checksums.ts';
import { nameParts, type PartyRole, type PiiKind, SurrogateMap } from './surrogates.ts';

/**
 * PII redaction before transmission.
 *
 * This is not a feature bolted on at the end; it is the boundary condition the pipeline is built
 * around, and the reason is documented rather than assumed. Google's Gemini API Additional Terms
 * state, verbatim, for the unpaid tier: **"Do not submit sensitive, confidential, or personal
 * information to the Unpaid Services"**, that Google uses submitted content "to provide, improve,
 * and develop Google products and services and machine learning technologies", and that
 * **"human reviewers may read, annotate, and process your API input and output"**.
 *
 * A free key receiving raw tenancy agreements — names, addresses, ID numbers, bank details —
 * therefore violates the provider's own terms of use. So the model never sees raw PII.
 *
 * **What this is not.** Automated PII detection is a strong mitigation and never a guarantee.
 * Even a vendor's own favourable figures put name-detection F1 at roughly 87 to 90 per cent —
 * about one name in eight missed — and location recall drops to around 0.46 on out-of-distribution
 * text. Presidio's own documentation states there is "no guarantee that Presidio will find all
 * sensitive information". LexMind says the same in its UI and its README, and discloses
 * transmission regardless of how well redaction performed.
 */

export interface RedactionResult {
  /** The text safe to transmit. */
  readonly text: string;
  /** In-process only. See `SurrogateMap`. */
  readonly map: SurrogateMap;
  /** Counts by kind. Safe to log and to display; holds no values. */
  readonly summary: Readonly<Record<string, number>>;
}

interface PatternDetector {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
  /** Validate a shape match, so "any twelve digits" does not redact half the document. */
  readonly validate?: (value: string) => boolean;
  /** Which capture group holds the identifier, when the pattern needs context around it. */
  readonly group?: number;
}

const DETECTORS: readonly PatternDetector[] = [
  { kind: 'email', pattern: /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu },
  {
    kind: 'card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: isValidLuhn,
  },
  {
    kind: 'aadhaar',
    pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
    validate: isValidVerhoeff,
  },
  { kind: 'pan', pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, validate: isValidPanFormat },
  { kind: 'ifsc', pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, validate: isValidIfscFormat },
  { kind: 'nric', pattern: /\b[STFGM]\d{7}[A-Z]\b/g, validate: isValidNric },
  { kind: 'nino', pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, validate: isValidNino },
  {
    // Context-anchored: a bare run of digits is a rent figure far more often than an account.
    kind: 'account',
    pattern: /\b(?:a\/c|account)(?:\s+(?:no\.?|number))?\s*[:.]?\s*(\d{9,18})\b/gi,
    group: 1,
  },
  {
    kind: 'phone',
    pattern: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{4,5}[\s-]?\d{4,6}\b/g,
    validate: (value) => {
      const digits = value.replace(/[^0-9]/g, '');
      // A phone number is 8 to 15 digits and, in practice here, written with a separator or a
      // country code — which is what keeps it from eating "50100234567890" or a rent figure.
      return digits.length >= 8 && digits.length <= 15 && /[+\s()-]/.test(value);
    },
  },
];

/** Roles a lease assigns, and the canonical role each maps to. */
const ROLE_WORDS: Readonly<Record<string, PartyRole>> = {
  landlord: 'landlord',
  lessor: 'landlord',
  licensor: 'landlord',
  owner: 'landlord',
  tenant: 'tenant',
  lessee: 'tenant',
  licensee: 'tenant',
};

const TITLE = '(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Prof)';

/**
 * A titled name: "Mr. Rajesh Kumar Sharma", "Ms Priya Ann Fernandes".
 *
 * Titles are the highest-precision name signal in a legal document, which is why they come first.
 */
const TITLED_NAME = new RegExp(`\\b${TITLE}\\.?\\s+((?:\\p{Lu}[\\p{L}'-]+)(?:\\s+\\p{Lu}[\\p{L}'-]+){0,3})`, 'gu');

/** A name immediately before a role label: `Rajesh Kumar Sharma ("the Landlord")`. */
const ROLE_LABELLED_NAME = new RegExp(
  `((?:\\p{Lu}[\\p{L}'-]+)(?:\\s+\\p{Lu}[\\p{L}'-]+){0,3})\\s*[,(]?\\s*[("']*\\s*the\\s+(${Object.keys(ROLE_WORDS).join('|')})\\b`,
  'giu',
);

/** An address introduced by a residence phrase, up to the sentence end. */
const CONTEXTUAL_ADDRESS =
  /\b(?:residing at|resident of|address(?:ed)? at|situated at|located at|premises at)\s+([^.;\n]{8,160})/gi;

/**
 * Words that look like names in a legal document but are not, so they must never be replaced.
 * Replacing "Landlord" with "Alan Pryce" would be worse than no redaction at all.
 */
const NOT_A_NAME = new Set([
  'landlord', 'lessor', 'licensor', 'tenant', 'lessee', 'licensee', 'owner', 'agreement',
  'agreements', 'schedule', 'annexure', 'article', 'section', 'clause', 'witness', 'witnesses',
  'premises', 'property', 'deposit', 'rent', 'act', 'india', 'state', 'court', 'act,', 'party',
  'parties', 'registration', 'whereas', 'therefore', 'the', 'this', 'said', 'per', 'month',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

function plausibleName(candidate: string): boolean {
  const parts = candidate.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return false;
  return parts.every((part) => {
    const bare = part.replace(/[^\p{L}'-]/gu, '');
    return bare.length > 1 && !NOT_A_NAME.has(bare.toLowerCase());
  });
}

/** Find who is the landlord and who is the tenant, so their surrogates never collide. */
function detectRoles(text: string): ReadonlyMap<string, PartyRole> {
  const roles = new Map<string, PartyRole>();
  for (const match of text.matchAll(ROLE_LABELLED_NAME)) {
    const candidate = (match[1] ?? '').trim();
    const roleWord = (match[2] ?? '').toLowerCase();
    const role = ROLE_WORDS[roleWord];
    if (role === undefined || !plausibleName(candidate)) continue;
    roles.set(candidate, role);
  }
  return roles;
}

function collectNames(text: string, roles: ReadonlyMap<string, PartyRole>): readonly string[] {
  const names = new Set<string>(roles.keys());
  for (const match of text.matchAll(TITLED_NAME)) {
    const candidate = (match[1] ?? '').trim();
    if (plausibleName(candidate)) names.add(candidate);
  }
  // Longest first: "Rajesh Kumar Sharma" must be registered before "Sharma".
  return [...names].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

function replaceAll(text: string, original: string, surrogate: string): string {
  // Word-bounded where the ends are letters, so "Ann" does not match inside "Announcement".
  const startsWord = /^[\p{L}\p{N}]/u.test(original);
  const endsWord = /[\p{L}\p{N}]$/u.test(original);
  const source = `${startsWord ? '\\b' : ''}${escapeRegExp(original)}${endsWord ? '\\b' : ''}`;
  return text.replace(new RegExp(source, 'gu'), surrogate);
}

export interface RedactOptions {
  /** Kinds to leave alone. Used by the evaluation harness to measure the redaction delta. */
  readonly skip?: readonly PiiKind[];
}

export function redact(input: string, options: RedactOptions = {}): RedactionResult {
  const skip = new Set(options.skip ?? []);
  const map = new SurrogateMap();
  let text = input;

  // ── Names first, with roles resolved, because coreference is what must survive ──────────────
  if (!skip.has('person')) {
    const roles = detectRoles(input);
    for (const fullName of collectNames(input, roles)) {
      const role = roles.get(fullName);
      const surrogate = map.assign('person', fullName, role);

      // Bind each part of the name to the matching part of the surrogate, so "Mr. Sharma" later
      // in the document becomes "Mr. Pryce" rather than being missed. This is what keeps a
      // surname-only reference pointing at the same party.
      const realParts = nameParts(fullName);
      const fakeParts = nameParts(surrogate);
      realParts.forEach((part, i) => {
        const replacement = fakeParts[Math.min(i, fakeParts.length - 1)];
        if (replacement !== undefined && part !== replacement) {
          map.bind('person', part, replacement, role);
        }
      });
    }
  }

  // ── Addresses, by context rather than by shape ───────────────────────────────────────────────
  if (!skip.has('address')) {
    for (const match of input.matchAll(CONTEXTUAL_ADDRESS)) {
      const address = (match[1] ?? '').trim();
      if (address.length >= 8) map.assign('address', address);
    }
  }

  // ── Validated identifiers ────────────────────────────────────────────────────────────────────
  for (const detector of DETECTORS) {
    if (skip.has(detector.kind)) continue;
    for (const match of input.matchAll(detector.pattern)) {
      const value = (detector.group === undefined ? match[0] : match[detector.group]) ?? '';
      if (value.length === 0) continue;
      if (detector.validate !== undefined && !detector.validate(value)) continue;
      map.assign(detector.kind, value);
    }
  }

  for (const original of map.originals()) {
    const surrogate = map.surrogateFor(original);
    if (surrogate !== undefined) text = replaceAll(text, original, surrogate);
  }

  return { text, map, summary: map.summary() };
}

/**
 * Put the real values back, immediately before rendering to the reader.
 *
 * Longest surrogate first, for the same reason redaction works longest-first.
 */
export function restore(text: string, map: SurrogateMap): string {
  let restored = text;
  for (const surrogate of map.surrogates()) {
    const original = map.originalFor(surrogate);
    if (original !== undefined) restored = replaceAll(restored, surrogate, original);
  }
  return restored;
}

/**
 * Assert that no original value survives in text about to be transmitted.
 *
 * Used by the adversarial suite to scan the serialised outbound request, which is the only check
 * that actually proves the property rather than describing it.
 */
export function findLeaks(outbound: string, map: SurrogateMap): readonly string[] {
  return map
    .replacements()
    .filter((replacement) => outbound.includes(replacement.original))
    .map((replacement) => `${replacement.kind}: ${replacement.original.slice(0, 8)}...`);
}
