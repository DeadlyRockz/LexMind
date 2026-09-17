import { describe, expect, it } from 'vitest';
import { type FakePort, fakePort } from '../../../../test/fixtures/fake-port.ts';
import {
  CLEAN_FAIR_LEASE,
  GOLDEN_LEASES,
  NEGOTIATION_PAIR,
  PII_DENSE_LEASE,
} from '../../../../test/fixtures/leases.ts';
import { analyse } from '../analyse/pipeline.ts';
import { ingestPastedText } from '../ingest/index.ts';
import { type SegmentedDocument, segment } from '../segment/index.ts';
import { isValidNric } from './checksums.ts';
import { prepareForModel } from './index.ts';
import { applyRedaction, redact, restore } from './redact.ts';
import { SurrogateMap } from './surrogates.ts';

/**
 * Redaction correctness: precision, reversibility and uniqueness.
 *
 * The redaction tests in `safety.test.ts` prove that PII *is* removed. These prove the three
 * things that were silently false and that decide whether the product still works afterwards:
 *
 *  - **Nothing that is not a name is treated as one.** The name pattern once ran with the `i`
 *    flag, under which `\p{Lu}` matches lowercase letters, so a lease naming nobody had "and",
 *    "to" and "QUIET ENJOYMENT" replaced with people — and every quote the model copied from that
 *    text failed verification.
 *  - **`restore(redact(x)) === x`.** Replacement ran value by value over its own output, so
 *    "fourteen days after" came back as "late late giving".
 *  - **No two originals share a surrogate,** and no surrogate is text the document already holds.
 */

const ALL_LEASES: readonly { readonly id: string; readonly text: string }[] = [
  ...GOLDEN_LEASES.map(({ id, text }) => ({ id, text })),
  { id: 'negotiation-before', text: NEGOTIATION_PAIR.before },
  { id: 'negotiation-after', text: NEGOTIATION_PAIR.after },
  { id: 'pii-dense', text: PII_DENSE_LEASE },
];

function personOriginals(text: string): readonly string[] {
  return redact(text)
    .map.replacements()
    .filter((replacement) => replacement.kind === 'person')
    .map((replacement) => replacement.original);
}

describe('a name is recognised by its capitals, not by the i flag', () => {
  it('finds nobody in a lease that names nobody, and sends it unchanged', () => {
    const result = redact(CLEAN_FAIR_LEASE);
    expect(personOriginals(CLEAN_FAIR_LEASE)).toEqual([]);
    expect(result.summary['person']).toBeUndefined();
    expect(result.text).toBe(CLEAN_FAIR_LEASE);
    expect(prepareForModel(CLEAN_FAIR_LEASE).channel).toContain(
      'This agreement is made between the landlord and the tenant named in the schedule.',
    );
  });

  it('finds nobody in any golden lease, because none of them names a person', () => {
    for (const lease of ALL_LEASES.filter(({ id }) => id !== 'pii-dense')) {
      expect(personOriginals(lease.text), lease.id).toEqual([]);
    }
  });

  it('still redacts a real name labelled with a lowercase role word', () => {
    const text =
      'This agreement is made between Rajesh Kumar Sharma, the landlord, and Priya Menon, the tenant.';
    const result = redact(text);

    for (const secret of ['Rajesh', 'Kumar', 'Sharma', 'Priya', 'Menon']) {
      expect(result.text, secret).not.toContain(secret);
    }
    expect(result.text).toContain(', the landlord, and ');
    expect(result.text).toContain(', the tenant.');

    const roles = new Map(result.map.replacements().map((r) => [r.original, r.role]));
    expect(roles.get('Rajesh Kumar Sharma')).toBe('landlord');
    expect(roles.get('Priya Menon')).toBe('tenant');
    expect(result.map.surrogateFor('Rajesh Kumar Sharma')).not.toBe(
      result.map.surrogateFor('Priya Menon'),
    );
  });

  it('never takes a lowercase word beside a role word for a name', () => {
    const text =
      'Rent is paid to the landlord and to the tenant, for the landlord and for the tenant, within fourteen days of the licensee leaving.';
    const result = redact(text);
    expect(result.map.size).toBe(0);
    expect(result.text).toBe(text);
  });

  it('reads role words in any case, and a quoted or "hereinafter" label as a definition', () => {
    const result = redact(
      'Between Rajesh Sharma ("THE LANDLORD") and Priya Menon, hereinafter referred to as the "Lessee".',
    );
    const roles = new Map(result.map.replacements().map((r) => [r.original, r.role]));
    expect(roles.get('Rajesh Sharma')).toBe('landlord');
    expect(roles.get('Priya Menon')).toBe('tenant');
    // "Between" is capitalised and sits in the run before the label, but it is not the name.
    expect(result.text.startsWith('Between ')).toBe(true);
  });

  it('accepts a quoted role word with no "the", and ignores a bare one', () => {
    expect(redact('Kiran Desai ("Tenant") signs.').map.surrogateFor('Kiran Desai')).toBeDefined();
    expect(redact('Common Area Landlord shall clean.').map.size).toBe(0);
  });

  it('does not treat a heading as a name, on its own line or joined to the paragraph', () => {
    for (const text of [
      '11. QUIET ENJOYMENT\nThe tenant may live in the property peacefully.',
      '11. QUIET ENJOYMENT The tenant may live in the property peacefully.',
      'HOLDING OVER, the tenant shall pay double rent.',
      // No word here is on any stop list: only the capitals say it is a heading.
      'RUBBISH REMOVAL, the tenant shall put the bins out weekly.',
      '12. Rubbish Removal The tenant shall put the bins out weekly.',
      '12. Rubbish Removal\nThe tenant shall put the bins out weekly.',
    ]) {
      const result = redact(text);
      expect(result.map.size, text).toBe(0);
      expect(result.text).toBe(text);
    }
  });

  it('does not treat a title-case heading or a sentence adverb as a name', () => {
    for (const text of [
      'Dispute Resolution, the tenant may apply to the tribunal.',
      'Accordingly, the landlord shall repair the roof.',
      'Upon Expiry, the tenant shall return the keys.',
      // One capitalised word on a bare comma is too little evidence to call it a person.
      'Thereupon, the tenant shall return the keys.',
    ]) {
      expect(redact(text).map.size, text).toBe(0);
    }
  });

  it('takes an all-caps name when a title vouches for it, and keeps it the same person', () => {
    const text = 'Mr. Arvind Shankar Kulkarni signs.\nSIGNED by MR. ARVIND SHANKAR KULKARNI';
    const result = redact(text);
    const plain = result.map.surrogateFor('Arvind Shankar Kulkarni') ?? '';

    expect(result.text).not.toMatch(/arvind|shankar|kulkarni/i);
    expect(result.map.surrogateFor('ARVIND SHANKAR KULKARNI')).toBe(plain.toUpperCase());
    // Counted once: one person, written twice.
    expect(result.summary['person']).toBe(1);
  });

  it('refuses a title in front of a word that is never a name', () => {
    expect(redact('Signed for and on behalf of Mr. Landlord.').map.size).toBe(0);
  });

  it('ends a titled name at a lease word, even when ingest joins the signature lines', () => {
    const text = 'SIGNED by MR. ARVIND KULKARNI SIGNED by Ms. April Lane on 1 May 2026';
    const result = redact(text);
    expect(result.text.match(/SIGNED by/g)).toHaveLength(2);
    expect(result.text).toContain('on 1 May 2026');
    // A title vouches for a name that happens to be a lease word too.
    expect(result.text).not.toMatch(/ARVIND|KULKARNI|April|Lane/);
  });

  it('names a relative after S/o, W/o or "son of", and shares the family name', () => {
    const result = redact(
      'Mr. Rajesh Sharma, son of Mahesh Sharma, and Ms. Meera Rao, W/o Late Shri Prakash Rao.',
    );
    expect(result.text).not.toMatch(/Rajesh|Mahesh|Sharma|Meera|Prakash|Rao/);
    const family = (name: string): string =>
      (result.map.surrogateFor(name) ?? '').split(' ')[1] ?? '';
    expect(family('Mahesh Sharma')).toBe(family('Rajesh Sharma'));
    expect(family('Prakash Rao')).toBe(family('Meera Rao'));
  });

  it('follows a name onto the next line, but not into a heading or a date', () => {
    const wrapped = redact('Paid to Mr. Rajesh Kumar\nSharma in advance.');
    expect(wrapped.text).not.toMatch(/Rajesh|Kumar|Sharma/);

    const dated = redact('Refunded by Mr. Sharma\nMay 2026\nRENT\nMr. Sharma\nHOLDING OVER');
    expect(dated.text).toContain('\nMay 2026\n');
    // Not lease vocabulary, but a heading in capitals cannot continue a name written in title case.
    expect(dated.text).toContain('\nHOLDING OVER');
    expect(dated.text).not.toContain('Sharma');
  });

  it('replaces a name that ends in a non-ASCII letter everywhere it appears', () => {
    // `\b` is ASCII-only, so "Soulé" once had no boundary after it and was never replaced at all.
    const result = redact('Mr. André Soulé acts for the landlord. Contact Mr. Soulé by post.');
    expect(result.text).not.toMatch(/André|Soulé/);
  });

  it('keeps a possessive outside the name it belongs to', () => {
    const result = redact("Ms. Joshi's deposit is held by Mr. Kulkarni.");
    const surrogate = result.map.surrogateFor('Joshi') ?? '';
    expect(result.text).toContain(`Ms. ${surrogate}'s deposit`);
  });
});

describe('an address needs something address-shaped after the residence phrase', () => {
  it('leaves "premises at any time without notice" alone — those words are the risk', () => {
    for (const lease of ALL_LEASES.filter(({ id }) => id !== 'pii-dense')) {
      expect(redact(lease.text).summary['address'], lease.id).toBeUndefined();
    }
    const text = 'The landlord may enter the premises at any time without notice.';
    expect(redact(text).text).toBe(text);
  });

  it('still redacts a numbered address, an Indian R/o address, and a named house', () => {
    const result = redact(
      [
        'residing at 44 Nehru Colony, Sector 12;',
        'R/o 17 Tilak Road, Sadashiv Peth;',
        'residing at Rose Villa, Hill Road;',
      ].join('\n'),
    );
    expect(result.summary['address']).toBe(3);
    expect(result.text).not.toMatch(/Nehru|Tilak|Rose Villa/);
  });

  it('ignores a residence phrase followed by too little to be an address', () => {
    expect(redact('residing at 12      ; nothing more').map.size).toBe(0);
  });
});

describe('restore(redact(x)) === x', () => {
  it('holds for every golden lease', () => {
    for (const lease of ALL_LEASES) {
      const result = redact(lease.text);
      expect(restore(result.text, result.map), lease.id).toBe(lease.text);
    }
  });

  it('holds through prepareForModel, which is the form the model actually receives', () => {
    for (const lease of ALL_LEASES) {
      const safe = prepareForModel(lease.text);
      expect(restore(safe.channel, safe.map), lease.id).toContain(lease.text.trim());
    }
  });

  it('reverses a name the model wrote without its middle name', () => {
    const result = redact('Rajesh Kumar Sharma ("the Landlord") shall repair.');
    const [given, , family] = (result.map.surrogateFor('Rajesh Kumar Sharma') ?? '').split(' ');
    expect(restore(`${given} ${family} agrees`, result.map)).toBe('Rajesh Sharma agrees');
    expect(restore(`Mr. ${family}`, result.map)).toBe('Mr. Sharma');
  });

  it('reverses a quote the model re-spaced onto one line', () => {
    const result = redact('Paid to Mr. Rajesh Kumar\nSharma in advance.');
    const oneLine = (result.map.surrogateFor('Rajesh Kumar\nSharma') ?? '').replace(/\s+/g, ' ');
    expect(oneLine.split(' ')).toHaveLength(3);
    expect(restore(`Mr. ${oneLine}`, result.map)).toBe('Mr. Rajesh Kumar Sharma');
  });

  it('never rewrites a word that merely contains a surrogate', () => {
    const result = redact('Rajesh Sharma ("the Landlord") shall repair.');
    const [given = '', family = ''] = (result.map.surrogateFor('Rajesh Sharma') ?? '').split(' ');
    const lookalike = `${given}a and ${family}ville`;
    expect(restore(lookalike, result.map)).toBe(lookalike);
  });

  it('returns text untouched when nothing was redacted', () => {
    expect(restore('Mr. Pryce', redact('No personal data here.').map)).toBe('Mr. Pryce');
  });
});

describe('applyRedaction, for excerpts of a document already redacted', () => {
  const lease = [
    'Mr. Rajesh Kumar Sharma, residing at 44 Nehru Colony, Sector 12, holding PAN ABCDE1234F.',
    'The deposit is refunded by Mr. Sharma to the tenant within thirty days.',
  ].join('\n');

  it('uses the same stand-ins as the whole document, so the model sees one cast of people', () => {
    const result = redact(lease);
    const excerpt = 'The deposit is refunded by Mr. Sharma to the tenant within thirty days.';
    const redacted = applyRedaction(excerpt, result.map);

    expect(result.text).toContain(redacted);
    expect(redacted).not.toContain('Sharma');
    expect(restore(redacted, result.map)).toBe(excerpt);
  });

  it('leaves an excerpt with nothing personal in it exactly as it was', () => {
    const result = redact(lease);
    expect(applyRedaction('Rent is due on the fifth day of each month.', result.map)).toBe(
      'Rent is due on the fifth day of each month.',
    );
  });
});

describe('the collision guard', () => {
  it('never mints a surrogate the document already contains', () => {
    // The landlord's first-choice stand-in is exactly the witness's real name.
    const text =
      'Rajesh Sharma ("the Landlord") lets the flat. Witnessed by Alan Pryce and Alana Price.';
    const result = redact(text);
    const landlord = result.map.surrogateFor('Rajesh Sharma') ?? '';

    expect(landlord).not.toMatch(/\bAlan\b|\bPryce\b/);
    expect(result.text).toContain('Witnessed by Alan Pryce');
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('checks the document word by word, so "Alana" does not use up "Alan"', () => {
    const map = new SurrogateMap('Signed by Alana Pryceton.');
    expect(map.assign('person', 'Rajesh Sharma', 'landlord')).toBe('Alan Pryce');
  });

  it('keeps every surrogate unique when the name pools run out', () => {
    const names = [
      'Ravi Iyer',
      'Anil Mehta',
      'Sunil Joshi',
      'Kavita Nair',
      'Deepak Bose',
      'Farah Khan',
      'Gopal Das',
      'Hema Pillai',
      'Imran Qureshi',
      'Jaya Menon',
      'Kiran Shetty',
      'Lalit Varma',
    ];
    const text = names.map((name) => `${name} ("the Landlord")`).join('; ');
    const result = redact(text);
    const surrogates = result.map.replacements().map((r) => r.surrogate);

    expect(new Set(surrogates).size).toBe(surrogates.length);
    expect(new Set(names.map((name) => result.map.surrogateFor(name))).size).toBe(names.length);
    // Past twelve landlords the realistic lists are spent and numbered stand-ins take over.
    expect(surrogates.some((surrogate) => /\d/.test(surrogate))).toBe(true);
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('keeps identifier surrogates unique past the point the old formats cycled', () => {
    const nrics = Array.from({ length: 12 }, (_, i) => {
      const digits = String(7654300 + i);
      const letter = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((l) => isValidNric(`S${digits}${l}`));
      return `S${digits}${letter}`;
    });
    const addresses = ['1 Elm Row', '2 Oak Row', '3 Ash Row', '4 Yew Row'].map(
      (street) => `residing at ${street}, Westbury;`,
    );
    const text = [`NRIC ${nrics.join(', NRIC ')}.`, ...addresses].join('\n');
    const result = redact(text);
    const surrogates = result.map.replacements().map((r) => r.surrogate);

    expect(result.summary['nric']).toBe(12);
    expect(result.summary['address']).toBe(4);
    expect(new Set(surrogates).size).toBe(surrogates.length);
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('gives a middle name its own stand-in rather than the family name', () => {
    const result = redact('Rajesh Kumar Sharma ("the Landlord"). Kumar and Sharma are both named.');
    expect(result.map.surrogateFor('Kumar')).not.toBe(result.map.surrogateFor('Sharma'));
    expect(restore(result.text, result.map)).toContain('Kumar and Sharma are both named.');
  });

  it('replaces the whole of two detections that overlap, and counts neither twice', () => {
    // The address runs to the end of its line; the phone number starts inside it and continues on
    // the next. Replacing one would leave half of the other in the prompt.
    const text = 'Residing at 8 Hill Road, telephone +91\n98200 12345, for the tenant.';
    const result = redact(text);

    expect(result.text).not.toMatch(/Hill|98200|12345/);
    expect(result.summary['address']).toBe(1);
    expect(result.summary['phone']).toBe(1);
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('keeps the kind of the larger detection when the later one is the larger', () => {
    // The address stops at the dot inside the email; the email runs on well past the address.
    const text = 'Residing at Flat 2, care of r.averyveryverylongmailbox@example.com today.';
    const result = redact(text);

    expect(result.text).not.toMatch(/Flat 2|averyvery|example\.com/);
    expect(result.text).toMatch(/Residing at party\d+@example\.invalid today\./);
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('widens a detection to the whole token, so no half of one reaches the prompt', () => {
    const text = 'Pay to account50100234567890 monthly.';
    const result = redact(text);
    expect(result.text).not.toContain('50100234567890');
    expect(restore(result.text, result.map)).toBe(text);
  });

  it('never mints an identifier stand-in the document already contains', () => {
    // A lease that happens to quote the first email stand-in verbatim.
    const text = 'Notices go to party1@example.invalid and to priya.menon@example.com.';
    const result = redact(text);
    const surrogates = result.map.replacements().map((r) => r.surrogate);

    expect(surrogates).not.toContain('party1@example.invalid');
    expect(result.text).not.toContain('priya.menon');
    expect(restore(result.text, result.map)).toBe(text);
  });
});

describe('skipping a kind, for the evaluation harness', () => {
  it('leaves exactly the skipped kinds in place and still redacts the rest', () => {
    const text = 'Mr. Rajesh Sharma, residing at 44 Nehru Colony, holds PAN ABCDE1234F.';
    const kept = redact(text, { skip: ['address', 'pan'] });

    expect(kept.text).toContain('44 Nehru Colony');
    expect(kept.text).toContain('ABCDE1234F');
    expect(kept.text).not.toMatch(/Rajesh|Sharma/);
    expect(kept.summary).toEqual({ person: 1 });
  });
});

describe('redaction cost', () => {
  it('stays linear on inputs built to make a pattern backtrack', () => {
    const hostile = [
      '1'.repeat(50_000),
      `Rajesh${' '.repeat(50_000)}x`,
      `${'Aa '.repeat(20_000)}the tenant`,
      `a@${'b'.repeat(30_000)}`,
    ];
    for (const text of hostile) {
      const started = performance.now();
      redact(text);
      const elapsed = performance.now() - started;
      // Each runs in a few milliseconds; the quadratic email pattern took over a second on the first.
      expect(elapsed, `${text.slice(0, 12)}… took ${elapsed.toFixed(0)}ms`).toBeLessThan(400);
    }
  });
});

// ── End to end, through the model boundary ───────────────────────────────────────────────────────

/**
 * A model that copies one sentence of the redacted document it was sent, verbatim, as its quote —
 * exactly what the prompt asks a real model to do.
 */
function quotingModel(opening: string): FakePort {
  return fakePort({
    'explain-clauses': () => ({ explanations: [] }),
    'summarise-lease': (request) => {
      const sent = request.document ?? '';
      const start = sent.indexOf(opening);
      return {
        sections: [
          {
            part: 'money',
            text: 'The agreement sets out who pays what, and when it is paid back.',
            quote:
              start < 0
                ? 'no such sentence was sent'
                : sent.slice(start, sent.indexOf('.', start) + 1),
          },
        ],
      };
    },
  });
}

function prepare(text: string): SegmentedDocument {
  return segment(ingestPastedText(text));
}

describe('a quote copied from the redacted text restores and verifies', () => {
  it('verifies a quote from a nameless lease, which redaction used to corrupt', async () => {
    const segmented = prepare(CLEAN_FAIR_LEASE);
    const port = quotingModel('The landlord shall return the deposit');

    const result = await analyse(segmented, { port });
    const section = result.summary?.sections[0];

    expect(port.requests.length).toBeGreaterThan(0);
    expect(section?.anchor.quote).toContain('fourteen days after the tenancy ends');
    expect(
      segmented.document.text.slice(section?.anchor.charStart ?? 0, section?.anchor.charEnd ?? 0),
    ).toBe(section?.anchor.quote);
    expect(result.stats.rejectedQuotes).toBe(0);
  });

  it('verifies a quote that carries a surrogate name, restored to the real one', async () => {
    const lease = [
      'TENANCY AGREEMENT',
      '',
      '1. PARTIES',
      'This agreement is made between Rajesh Kumar Sharma, the landlord, and Priya Menon,',
      'the tenant, for the flat described in the schedule.',
      '',
      '2. RENT',
      'The tenant shall pay rent of 25,000 each month to Mr. Sharma, in advance.',
    ].join('\n');
    const segmented = prepare(lease);
    const port = quotingModel('This agreement is made between');

    const result = await analyse(segmented, { port });
    const sent = port.requests.map((request) => request.document ?? '').join('\n');
    const section = result.summary?.sections[0];

    // The model saw only stand-ins, and quoted them...
    expect(sent).not.toMatch(/Rajesh|Kumar|Sharma|Priya|Menon/);
    expect(sent).toContain(', the landlord, and ');
    // ...and the reader sees the real names, anchored to the real document.
    expect(section?.anchor.quote).toContain(
      'made between Rajesh Kumar Sharma, the landlord, and Priya Menon, the tenant,',
    );
    expect(
      segmented.document.text.slice(section?.anchor.charStart ?? 0, section?.anchor.charEnd ?? 0),
    ).toBe(section?.anchor.quote);
    expect(result.stats.verifiedQuotes).toBeGreaterThan(0);
    expect(result.stats.rejectedQuotes).toBe(0);
  });
});
