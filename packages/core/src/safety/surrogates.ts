/**
 * The surrogate map.
 *
 * **It never leaves the process.** Not serialised, not logged, not persisted, and never sent to a
 * model. Reversal happens in memory immediately before rendering to the reader. The map is held
 * behind a class with no enumerable data and no `toJSON`, so an accidental
 * `JSON.stringify(result)` somewhere downstream cannot leak it — a guarantee a plain object
 * literal cannot offer.
 *
 * **Reversal is exact by construction, not by luck.** `restore(redact(x)) === x` holds because
 * every surrogate this map mints satisfies three rules, each enforced here:
 *
 *  1. **Unique.** No two originals ever share a surrogate, so reversing one is never a guess. The
 *     old pool simply cycled, so a fourth landlord became "Alan Pryce" again, and "Kumar" and
 *     "Sharma" both became "Pryce" — after which "Pryce" could only ever turn back into one of them.
 *  2. **Absent from the document.** A surrogate never already occurs in the source as a whole word,
 *     so restoring can never rewrite text the author wrote. A lease that names a witness "Alan
 *     Pryce" gets a different stand-in for its landlord.
 *  3. **Built part by part for people.** Given, middle and family names each get their own stand-in,
 *     and the full surrogate is exactly those parts in the original's own spacing. So "Rajesh
 *     Sharma", written later without the middle name, still reverses to the right words — and a
 *     quote the model re-spaced onto one line still reverses to text the verifier can find.
 *
 * **Collision policy: take the next unused stand-in, never throw.** Minting was already a walk
 * through a pool, so continuing the walk is the existing design rather than a new one — and a lease
 * with a fourth landlord, or a witness who happens to share a stand-in's name, is a document to
 * analyse, not an error to show the reader. Past the realistic pools, stand-ins are numbered
 * ("Pryce2"), which keeps them unique forever.
 */

export type PiiKind =
  | 'person'
  | 'address'
  | 'email'
  | 'phone'
  | 'pan'
  | 'aadhaar'
  | 'nric'
  | 'nino'
  | 'account'
  | 'ifsc'
  | 'card';

export type PartyRole = 'landlord' | 'tenant' | 'other';

export interface Replacement {
  readonly kind: PiiKind;
  readonly original: string;
  readonly surrogate: string;
  readonly role?: PartyRole;
}

/**
 * Realistic, type-matched, role-distinct surrogates — and the reasoning matters, because this is
 * where naive redaction destroys the product.
 *
 * Replacing every name with `<PERSON>` collapses "Mr. Tan", "the Tenant" and "Mr. Tan's spouse"
 * into one token, which destroys coreference. Worse, **the landlord and the tenant both become
 * `<PERSON>`** — and a lease is precisely a two-party obligation matrix, so that failure is fatal
 * to the core feature: the asymmetry engine can no longer tell who owes what to whom.
 *
 * So: the landlord maps to one stable fake name, the tenant to a different one, the same surrogate
 * on every occurrence, reversed on the way out. Consistency preserves coreference; realism keeps
 * the text on-distribution for the model.
 */
const NAME_POOL: Readonly<
  Record<PartyRole, readonly (readonly [given: string, family: string])[]>
> = {
  landlord: [
    ['Alan', 'Pryce'],
    ['Martin', 'Dalby'],
    ['Howard', 'Leng'],
  ],
  tenant: [
    ['Dana', 'Whitfield'],
    ['Rosa', 'Kemble'],
    ['Nina', 'Alder'],
  ],
  other: [
    ['Chris', 'Marlow'],
    ['Sam', 'Verity'],
    ['Lee', 'Ashford'],
    ['Jo', 'Barrow'],
  ],
};

/** Stand-ins for middle names, drawn from their own list so they never take a family name's. */
const MIDDLE_NAMES: readonly string[] = ['Ellis', 'Hollis', 'Reid', 'Carden', 'Lowrie', 'Fenn'];

const ROLES: readonly PartyRole[] = ['landlord', 'tenant', 'other'];

type NameSlot = 'given' | 'middle' | 'family';

const ADDRESS_POOL: readonly string[] = [
  '18 Gallows Lane, Flat 4, Northtown 100001',
  '7 Marsh Row, Unit 2, Eastfield 200002',
  '221 Quarry Street, Apartment 9, Westbury 300003',
];

/** One word of a name, as it is split for part-by-part surrogates. */
const NAME_TOKEN = /\p{L}[\p{L}'’-]*/gu;

const WORD_CHAR = '[\\p{L}\\p{N}_]';
const STARTS_WITH_WORD_CHAR = /^[\p{L}\p{N}_]/u;
const ENDS_WITH_WORD_CHAR = /[\p{L}\p{N}_]$/u;

/**
 * A regular-expression source matching `value` literally, and only as a whole word where it starts
 * or ends with a letter or digit — so "Ann" never matches inside "Announcement".
 *
 * Unicode-aware on purpose: `\b` is ASCII-only even under the `u` flag, so a name ending in "é"
 * never had a boundary after it and was silently never replaced.
 */
export function boundedSource(value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = STARTS_WITH_WORD_CHAR.test(value) ? `(?<!${WORD_CHAR})` : '';
  const tail = ENDS_WITH_WORD_CHAR.test(value) ? `(?!${WORD_CHAR})` : '';
  return `${head}${escaped}${tail}`;
}

/** Whether `value` appears in `text` as a whole word, by the same rule restoration matches with. */
export function occursAsWord(text: string, value: string): boolean {
  return text.includes(value) && new RegExp(boundedSource(value), 'u').test(text);
}

/** The stand-ins for one slot of a name: the role's own list first, then every other role's. */
function slotPool(slot: NameSlot, role: PartyRole): readonly string[] {
  if (slot === 'middle') return MIDDLE_NAMES;
  const ordered = [role, ...ROLES.filter((other) => other !== role)];
  return ordered.flatMap((owner) =>
    NAME_POOL[owner].map(([given, family]) => (slot === 'given' ? given : family)),
  );
}

/** The pool starting from its `by`-th entry, so the second landlord starts at the second name. */
function rotated(pool: readonly string[], by: number): readonly string[] {
  const at = by % pool.length;
  return [...pool.slice(at), ...pool.slice(0, at)];
}

/** The n-th stand-in to try: the pool once through, then numbered rounds of it, forever. */
function candidateAt(pool: readonly string[], n: number): string {
  const round = Math.floor(n / pool.length);
  return `${pool[n % pool.length]}${round === 0 ? '' : round + 1}`;
}

/** The n-th stand-in for an identifier. Every kind is unbounded, so the walk always terminates. */
function identifierAt(kind: Exclude<PiiKind, 'person'>, n: number): string {
  const serial = String(1000 + n);
  switch (kind) {
    case 'address':
      return ADDRESS_POOL[n] ?? `${n + 1} Quarry Street, Apartment ${n + 1}, Westbury 300003`;
    case 'email':
      return `party${n + 1}@example.invalid`;
    case 'phone':
      return `+44 20 7946 ${serial}`;
    case 'pan':
      return `AAAPA${serial}A`;
    case 'aadhaar':
      // Deliberately starts with 0, which a real Aadhaar never does, so a surrogate can never be
      // mistaken for a genuine number if it escapes into a log.
      return `0000 0000 ${serial}`;
    case 'nric':
      return `S${String(n).padStart(7, '0')}A`;
    case 'nino':
      return `AA${String(n).padStart(6, '0')}A`;
    case 'account':
      return `0000000000${String(n + 1).padStart(4, '0')}`;
    case 'ifsc':
      return `AAAA0${String(100000 + n)}`;
    case 'card':
      return `0000 0000 0000 ${serial}`;
  }
}

export class SurrogateMap {
  readonly #source: string;
  #forward = new Map<string, Replacement>();
  #reverse = new Map<string, string>();
  /** Originals registered as a by-product — a name part, an overlap — and so not counted. */
  #derived = new Set<string>();
  #counters = new Map<PiiKind, number>();
  #roleCounters = new Map<PartyRole, number>();
  /** Name part, lower-cased, to the stand-in its first spelling received. */
  #caseless = new Map<string, string>();
  #pattern: RegExp | undefined;

  /**
   * @param source The document being redacted. No surrogate is minted that already occurs in it
   *   as a whole word, which is what lets restoration never touch the author's own text.
   */
  constructor(source: string) {
    this.#source = source;
  }

  /** Register a mapping, reusing any surrogate already assigned to this original. */
  assign(kind: PiiKind, original: string, role?: PartyRole): string {
    return this.#assign(kind, original, role, false);
  }

  /**
   * Register a stretch that joins two overlapping detections — an address that runs into a phone
   * number on the next line — so every character either detection covered is replaced. It takes
   * the kind of the larger detection and is not counted in the summary: nothing new was found.
   */
  assignOverlap(kind: PiiKind, original: string, role?: PartyRole): string {
    return this.#assign(kind, original, role, true);
  }

  surrogateFor(original: string): string | undefined {
    return this.#forward.get(original)?.surrogate;
  }

  replacements(): readonly Replacement[] {
    return [...this.#forward.values()];
  }

  /** Surrogates, longest first, so a longer one wins where two start at the same place. */
  surrogates(): readonly string[] {
    return [...this.#reverse.keys()].sort((a, b) => b.length - a.length);
  }

  originalFor(surrogate: string): string | undefined {
    return this.#reverse.get(surrogate);
  }

  /**
   * One pattern matching any surrogate as a whole word, longest first, or `undefined` when nothing
   * was replaced. Global, so use it with `String.prototype.replace` or `matchAll` only.
   */
  surrogatePattern(): RegExp | undefined {
    if (this.#reverse.size === 0) return undefined;
    this.#pattern ??= new RegExp(this.surrogates().map(boundedSource).join('|'), 'gu');
    return this.#pattern;
  }

  get size(): number {
    return this.#forward.size;
  }

  /**
   * How many of each kind were found. Safe to show and to log: counts, never values.
   *
   * A value is counted once however it was written — not once per name part, and not again for
   * "ARVIND KULKARNI" in the signature block or a number re-spaced — so "2 person" in an export
   * means two people.
   */
  summary(): Readonly<Record<string, number>> {
    const seen = new Set<string>();
    const counts: Record<string, number> = {};
    for (const { kind, original } of this.#forward.values()) {
      const key = `${kind}:${original.toLowerCase().replace(/[\s-]+/g, '')}`;
      if (this.#derived.has(original) || seen.has(key)) continue;
      seen.add(key);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Refuse serialisation. If some future code path stringifies a result object that happens to
   * carry the map, this throws instead of quietly emitting every real name in the document.
   */
  toJSON(): never {
    throw new Error(
      'The surrogate map must never be serialised: it holds the real personal data from the document.',
    );
  }

  #assign(kind: PiiKind, original: string, role: PartyRole | undefined, derived: boolean): string {
    const existing = this.#forward.get(original);
    if (existing !== undefined) return existing.surrogate;

    const surrogate =
      kind === 'person' ? this.#mintPerson(original, role ?? 'other') : this.#mintIdentifier(kind);
    this.#register({ kind, original, surrogate, ...(role === undefined ? {} : { role }) }, derived);
    return surrogate;
  }

  #register(replacement: Replacement, derived: boolean): void {
    this.#forward.set(replacement.original, replacement);
    this.#reverse.set(replacement.surrogate, replacement.original);
    // A one-word name is registered first as its own part, then as the name itself: it counts.
    if (derived) this.#derived.add(replacement.original);
    else this.#derived.delete(replacement.original);
    this.#pattern = undefined;
  }

  /** Free means: not already standing in for something, and not already written in the document. */
  #isFree(candidate: string): boolean {
    return !this.#reverse.has(candidate) && !occursAsWord(this.#source, candidate);
  }

  /**
   * A person's surrogate, part by part, in the original's own spacing.
   *
   * A part already seen keeps its stand-in, so "Mahesh Sharma" after "Rajesh Kumar Sharma" shares
   * the family name's surrogate — coreference between relatives survives, not just within a name.
   */
  #mintPerson(original: string, role: PartyRole): string {
    const nth = this.#roleCounters.get(role) ?? 0;
    this.#roleCounters.set(role, nth + 1);

    const parts = [...original.matchAll(NAME_TOKEN)];
    const last = parts.length - 1;
    let surrogate = '';
    let cursor = 0;
    for (const [i, part] of parts.entries()) {
      const slot: NameSlot = i === last ? 'family' : i === 0 ? 'given' : 'middle';
      surrogate +=
        original.slice(cursor, part.index) + this.#partSurrogate(part[0], slot, role, nth);
      cursor = part.index + part[0].length;
    }
    return surrogate + original.slice(cursor);
  }

  #partSurrogate(part: string, slot: NameSlot, role: PartyRole, nth: number): string {
    const existing = this.#forward.get(part);
    if (existing !== undefined) return existing.surrogate;

    // The same word in another case — "KULKARNI" in the signature block, "Kulkarni" in the parties
    // clause — is the same person, so it is offered the same stand-in, in the matching case.
    const key = part.toLowerCase();
    const sibling = this.#caseless.get(key);
    const pool =
      sibling === undefined
        ? rotated(slotPool(slot, role), nth)
        : [sibling, ...slotPool(slot, role)];
    const shouted = part === part.toUpperCase();

    for (let n = 0; ; n += 1) {
      const plain = candidateAt(pool, n);
      const candidate = shouted ? plain.toUpperCase() : plain;
      if (!this.#isFree(candidate)) continue;
      if (sibling === undefined) this.#caseless.set(key, plain);
      this.#register({ kind: 'person', original: part, surrogate: candidate, role }, true);
      return candidate;
    }
  }

  #mintIdentifier(kind: Exclude<PiiKind, 'person'>): string {
    for (let n = this.#counters.get(kind) ?? 0; ; n += 1) {
      const candidate = identifierAt(kind, n);
      if (this.#isFree(candidate)) {
        this.#counters.set(kind, n + 1);
        return candidate;
      }
    }
  }
}
