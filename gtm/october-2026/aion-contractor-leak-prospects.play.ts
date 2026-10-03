/** @mermaid aion-contractor-leak-prospects
 * flowchart TD
 * seeds[("Maps discovery queries")] --> accounts[("Selected contractor accounts")]
 * accounts --> loop
 * subgraph loop["For each contractor account"]
 *   reviews["Pull lowest-rated Google reviews"] --> hiring["Search office or dispatch hiring"]
 *   hiring --> site["Scrape homepage contact flow"]
 *   site --> contacts["Find owners in DropLeads"]
 *   contacts --> fallback["Fallback native contact search"]
 *   fallback --> email1[["Verify first contact email"]]
 *   email1 --> email2[["Verify second contact email"]]
 *   email2 --> score["Score fit and pain, write opener"]
 * end
 * loop --> out["Return sequencing-ready prospects"]
 */
import { definePlay } from 'deepline';

type SeedAccount = {
  business_id: string;
  company: string;
  domain: string;
  website: string;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  trade?: string | null;
  review_count?: number | null;
  rating?: number | null;
  booking_link?: string | null;
  maps_emails?: string | null;
};

type Input = {
  // Supply accounts directly (cheapest: reuses an earlier Maps pull or an Apollo export)…
  accounts?: SeedAccount[];
  // …or let the Play discover them from Google Maps queries.
  queries?: string[];
  per_query_limit?: number;
  min_reviews?: number;
  max_reviews?: number;
  max_accounts?: number;
  exclude_name_patterns?: string[];
  reviews_per_account?: number;
  contacts_per_account?: number;
  as_of_date?: string;
};

const DECISION_TITLE_TERMS = [
  'Owner', 'President', 'CEO', 'Founder', 'General Manager', 'COO',
  'Operations Manager', 'Office Manager', 'Service Manager',
];

const TITLE_PRIORITY: Array<[RegExp, number]> = [
  // Checked in order: "Vice President" must not fall into the "President" tier.
  [/\b(vice president|vp|svp|evp)\b/i, 1],
  [/\b(owner|founder|president|ceo|chief executive)\b/i, 3],
  [/\b(general manager|coo|chief operating|operations manager|director of operations|office manager|service manager)\b/i, 2],
];

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'fit_score',
    'pain_score',
    'primary_pain',
    'pain_evidence',
    'evidence_source',
    'opener',
    'size_band_guess',
    'evidence_recency',
  ],
  properties: {
    fit_score: { type: 'integer', minimum: 1, maximum: 10 },
    pain_score: { type: 'integer', minimum: 1, maximum: 10 },
    evidence_recency: { type: 'string', enum: ['last_12_months', '12_to_24_months', 'older_than_24_months', 'none'] },
    primary_pain: {
      type: 'string',
      enum: ['lead_follow_up', 'estimate_follow_up', 'job_to_billing_handoff', 'insufficient_evidence'],
    },
    pain_evidence: { type: 'string' },
    evidence_source: { type: 'string', enum: ['reviews', 'hiring', 'website', 'mixed', 'none'] },
    opener: { type: 'string' },
    size_band_guess: { type: 'string', enum: ['<10', '10-25', '25-50', '50-100', '100+', 'unknown'] },
  },
};

const ASSESSMENT_SYSTEM =
  'You qualify US home-service contractors for AION, which finds and fixes revenue/operational leaks between lead -> job -> payment. ' +
  'fit_score (1-10): ideal is 10-100 employees, multiple field techs, an office/dispatch function, meaningful lead volume (many Google reviews, multiple service areas). ' +
  'Use linkedin_employee_count when present. National franchises, PE roll-ups with large call centers, and solo operators are poor fits. ' +
  'pain_score (1-10): strength and recency of evidence for one of: ' +
  'lead_follow_up (missed calls, slow callbacks, unanswered inquiries, no online booking, answering-service complaints), ' +
  'estimate_follow_up (quotes never sent or never followed up, stalled proposals), ' +
  'job_to_billing_handoff (invoice errors or delays, billing disputes, poor post-job communication, office/field miscommunication). ' +
  'Hiring for dispatchers, CSRs, or office staff is supporting evidence of intake/handoff load. ' +
  'Weight evidence from the last 24 months (relative to today) far above older evidence; evidence older than 24 months alone caps pain_score at 4. ' +
  'Use only the evidence given; cite concrete items with dates in pain_evidence. If evidence is weak, use insufficient_evidence. ' +
  'opener: one sentence, under 30 words, the first line of a cold email from AION to the owner. Reference the observed pattern tactfully as something ' +
  'common in growing shops (e.g. hiring, call volume, a few reviews mentioning callbacks), never quote or accuse, no flattery, no mention of AI, ' +
  'no claims the evidence does not support.';

function domainOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function listOf(result: any, name: string): Promise<any[]> {
  const getter = result?.extractedLists?.[name];
  if (getter) {
    const value = await getter.get();
    if (Array.isArray(value)) return value;
  }
  const raw = result?.toolResponse?.rawV2?.data ?? result?.toolResponse?.raw?.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.[name])) return raw[name];
  return [];
}

type Person = {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  linkedin: string | null;
  company_size: number | null;
  source: string;
};

function normalizeLinkedin(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^http:\/\//, 'https://').replace(/\/$/, '');
}

function titleRank(title: string | null): number {
  for (const [re, rank] of TITLE_PRIORITY) if (re.test(title ?? '')) return rank;
  return 0;
}

function dedupePeople(people: Person[]): Person[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    // One company rarely has two decision-makers with the same first name; providers
    // often list one person twice under different titles or with a missing last name.
    const key = String(p.first_name ?? p.full_name ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankPeople(people: Person[]): Person[] {
  const ranked = people
    .filter((p) => titleRank(p.title) > 0)
    .sort((a, b) => titleRank(b.title) - titleRank(a.title) || Number(Boolean(b.last_name)) - Number(Boolean(a.last_name)));
  return dedupePeople(ranked);
}

function canSeekEmail(person: Person | undefined): boolean {
  return Boolean(person?.first_name && person?.last_name);
}

// Prefer a personal-looking address the business already publishes on Google Maps
// (validated), and only then pay for the mailbox-verified email waterfall.
async function resolveEmail(rowCtx: any, row: any, person: Person) {
  const first = String(person.first_name ?? '').toLowerCase();
  const last = String(person.last_name ?? '').toLowerCase();
  const published = String(row.maps_emails ?? '')
    .split(/;\s*/)
    .filter(Boolean)
    .find((e) => {
      const local = e.split('@')[0].toLowerCase();
      return e.toLowerCase().endsWith(`@${row.domain}`) && first.length > 1 &&
        (local === first || local.startsWith(`${first}.`) || local === `${first}${last}` || local === `${first[0]}${last}`);
    });
  if (published) {
    const check = await rowCtx.tools.execute({
      id: 'maps_email_validation',
      tool: 'leadmagic_email_validation',
      input: { email: published },
      description: 'Validate the decision-maker address the business publishes on Google Maps.',
    });
    const payload: any = payloadOf(check);
    const status = String(payload?.email_status ?? payload?.data?.email_status ?? '').toLowerCase();
    if (status === 'valid') {
      return { email: published, email_source: 'google_maps+leadmagic_validation', email_validated: true, validation_status: status };
    }
  }
  const waterfall: any = await rowCtx.runPlay(
    'email_waterfall',
    'prebuilt/name-and-domain-to-email-waterfall',
    {
      first_name: String(person.first_name),
      last_name: String(person.last_name),
      domain: String(row.domain),
      company_name: String(row.company),
      ...(person.linkedin ? { linkedin_url: person.linkedin } : {}),
    },
    { description: 'Find a mailbox-verified work email for this decision-maker.' },
  );
  return {
    email: waterfall?.email ?? null,
    email_source: waterfall?.email_source ?? null,
    email_validated: waterfall?.email_validated ?? null,
    validation_status: null,
  };
}

function payloadOf(result: any): any {
  const response = result?.toolResponse;
  if (!response) return {};
  return response.view === 'data' ? (response.rawV2?.data ?? {}) : (response.rawV2 ?? {});
}

function receiptOf(result: any): string | null {
  return result?._metadata?.execution?.receiptKey ?? null;
}

export default definePlay(
  'aion-contractor-leak-prospects',
  async (ctx, input: Input = {}) => {
    const minReviews = input.min_reviews ?? 60;
    const maxReviews = input.max_reviews ?? 1500;
    const maxAccounts = input.max_accounts ?? 25;
    const excludes = (input.exclude_name_patterns ?? ['service experts', 'one hour', 'aire serv', 'ars ', 'mr. rooter', 'roto-rooter'])
      .map((p) => p.toLowerCase());

    let seeds: SeedAccount[] = input.accounts ?? [];

    if (!seeds.length) {
      // @mermaid-node seeds type:"dataset" out:"discovered"
      const discovered = await ctx
        .dataset('maps-queries', (input.queries ?? []).map((query) => ({ query })))
        .withColumn('businesses', async (row, rowCtx) => {
          const result = await rowCtx.tools.execute({
            id: 'maps_search',
            tool: 'openwebninja_localbusiness_search',
            input: { query: row.query, limit: input.per_query_limit ?? 20, extract_emails_and_contacts: true },
            description: 'Discover home-service contractors on Google Maps for this query.',
          });
          return (await listOf(result, 'data')).map((b: any) => ({
            business_id: b.business_id,
            company: b.name,
            website: b.website ?? '',
            domain: domainOf(b.website),
            phone: b.phone_number ?? null,
            city: b.city ?? null,
            state: b.state ?? null,
            trade: b.type ?? null,
            review_count: b.review_count ?? null,
            rating: b.rating ?? null,
            booking_link: b.booking_link ?? null,
            maps_emails: (b.emails_and_contacts?.emails ?? []).join('; ') || null,
          }));
        })
        .run({ key: 'query', description: 'Run each Google Maps discovery query.' });

      const seen = new Set<string>();
      for await (const row of discovered) {
        for (const b of (row.businesses ?? []) as SeedAccount[]) {
          if (!b.domain || seen.has(b.domain)) continue;
          seen.add(b.domain);
          seeds.push(b);
        }
      }
    }

    const selected = seeds
      .filter((a) => a.domain)
      .filter((a) => !excludes.some((p) => a.company.toLowerCase().includes(p)))
      .filter((a) => a.review_count == null || (a.review_count >= minReviews && a.review_count <= maxReviews))
      .slice(0, maxAccounts);

    // @mermaid-node accounts type:"dataset" out:"prospects"
    const prospects = await ctx
      .dataset('contractor-accounts', selected)
      // @mermaid-node reviews out:"low_reviews"
      .withColumn('low_reviews', async (row, rowCtx) => {
        const result = await rowCtx.tools.execute({
          id: 'low_reviews',
          tool: 'openwebninja_localbusiness_business_reviews',
          input: { business_id: row.business_id, limit: input.reviews_per_account ?? 10, sort_by: 'lowest_ranking' },
          description: 'Pull the lowest-rated Google reviews to find follow-up, estimate, or billing complaints.',
        });
        return (await listOf(result, 'data'))
          .map((r: any) => ({
            rating: r.rating ?? null,
            date: r.review_datetime_utc ?? r.review_time ?? null,
            text: String(r.review_text ?? '').slice(0, 600),
          }))
          .filter((r) => r.text);
      })
      // @mermaid-node hiring out:"hiring_hits"
      .withColumn('hiring_hits', async (row, rowCtx) => {
        const result = await rowCtx.tools.execute({
          id: 'hiring_search',
          tool: 'serper_google_search',
          input: {
            query: `"${row.company}" (dispatcher OR "customer service representative" OR CSR OR "office manager" OR "call center") job`,
            num: 10,
          },
          description: 'Look for live office, CSR, or dispatch hiring that signals intake or handoff strain.',
        });
        return (await listOf(result, 'organic')).slice(0, 6).map((o: any) => ({
          title: o.title ?? '',
          link: o.link ?? '',
          snippet: o.snippet ?? '',
          date: o.date ?? null,
        }));
      })
      // @mermaid-node site out:"homepage_excerpt"
      .withColumn('homepage_excerpt', async (row, rowCtx) => {
        const result = await rowCtx.tools.execute({
          id: 'homepage_scrape',
          tool: 'firecrawl_scrape',
          input: { url: row.website, formats: ['markdown'], onlyMainContent: false, timeout: 30000 },
          description: 'Read the homepage to see how leads book, request estimates, or pay.',
        });
        const raw: any = payloadOf(result);
        const md = String(raw?.data?.markdown ?? raw?.markdown ?? '');
        return md.slice(0, 4000);
      })
      // @mermaid-node contacts out:"contacts"
      .withColumn('contacts', async (row, rowCtx) => {
        const result = await rowCtx.tools.execute({
          id: 'dropleads_people',
          tool: 'dropleads_search_people',
          input: {
            filters: { companyDomains: [row.domain], jobTitles: DECISION_TITLE_TERMS },
            pagination: { page: 1, limit: 15 },
          },
          description: 'Find owners and operators at this contractor in the free DropLeads index.',
        });
        const payload: any = payloadOf(result);
        const leads: any[] = payload?.data?.leads ?? payload?.leads ?? [];
        const people = rankPeople(
          leads.map((p) => ({
            first_name: p.firstName ?? null,
            last_name: p.lastName ?? null,
            full_name: p.fullName ?? null,
            title: p.title ?? null,
            linkedin: normalizeLinkedin(p.linkedinUrl),
            company_size: p.companySize ?? null,
            source: 'dropleads',
          })),
        );
        return { people, company_size: leads[0]?.companySize ?? null, receipt: receiptOf(result) };
      })
      // @mermaid-node fallback out:"native_contacts"
      .withColumn('native_contacts', {
        runIf: (row) => !(row.contacts as any)?.people?.length,
        run: async ({ row, ctx: rowCtx }) => {
          const result = await rowCtx.tools.execute({
            id: 'native_people',
            tool: 'deepline_native_search_contact',
            input: {
              domain: row.domain,
              title_filters: [
                { name: 'owners', filter: 'Owner OR President OR General Manager' },
                { name: 'operators', filter: 'Operations Manager OR Office Manager OR Service Manager' },
              ],
              page_size: 2,
            },
            description: 'Fallback search for owners and operators when DropLeads has no match.',
          });
          const payload: any = payloadOf(result);
          const persons: any[] = payload?.output?.persons ?? [];
          return {
            people: rankPeople(
              persons.map((p) => ({
                first_name: p.first_name ?? null,
                last_name: p.last_name ?? null,
                full_name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
                title: p.title ?? null,
                linkedin: normalizeLinkedin(p.linkedin_url),
                company_size: null,
                source: 'deepline_native',
              })),
            ),
            receipt: receiptOf(result),
          };
        },
      })
      .withColumn('decision_makers', (row) =>
        dedupePeople([...((row.contacts as any)?.people ?? []), ...((row.native_contacts as any)?.people ?? [])]).slice(
          0,
          input.contacts_per_account ?? 2,
        ),
      )
      // @mermaid-node email1 out:"contact_1_email_result"
      .withColumn('contact_1_email_result', {
        runIf: (row) => canSeekEmail((row.decision_makers as any[])?.[0]),
        run: async ({ row, ctx: rowCtx }) =>
          resolveEmail(rowCtx, row, (row.decision_makers as any[])[0]),
      })
      // @mermaid-node email2 out:"contact_2_email_result"
      .withColumn('contact_2_email_result', {
        runIf: (row) => canSeekEmail((row.decision_makers as any[])?.[1]),
        run: async ({ row, ctx: rowCtx }) =>
          resolveEmail(rowCtx, row, (row.decision_makers as any[])[1]),
      })
      // @mermaid-node score out:"assessment"
      .withColumn('assessment', async (row, rowCtx) => {
        const evidence = {
          today: input.as_of_date ?? '2026-10-03',
          company: row.company,
          city: row.city,
          state: row.state,
          trade: row.trade,
          linkedin_employee_count: (row.contacts as any)?.company_size ?? null,
          google_rating: row.rating,
          google_review_count: row.review_count,
          has_maps_booking_link: Boolean(row.booking_link),
          lowest_rated_reviews: row.low_reviews,
          hiring_search_results: row.hiring_hits,
          homepage_excerpt: row.homepage_excerpt,
        };
        const result = await rowCtx.tools.execute({
          id: 'leak_assessment_v2',
          tool: 'ai_inference',
          input: {
            system: ASSESSMENT_SYSTEM,
            prompt: JSON.stringify(evidence),
            jsonSchema: SCORE_SCHEMA,
            maxOutputTokens: 4000,
            providerOptions: { openai: { reasoningEffort: 'low' } },
          },
          description: 'Score fit and leak evidence, tag primary pain, and draft an evidence-based opener.',
        });
        const raw: any = payloadOf(result);
        return raw?.result?.object ?? raw?.extracted_json ?? null;
      })
      .withColumn('contact_1_name', (row) => (row.decision_makers as any[])?.[0]?.full_name ?? null)
      .withColumn('contact_1_title', (row) => (row.decision_makers as any[])?.[0]?.title ?? null)
      .withColumn('contact_1_linkedin', (row) => (row.decision_makers as any[])?.[0]?.linkedin ?? null)
      .withColumn('contact_1_email', (row) => (row.contact_1_email_result as any)?.email ?? null)
      .withColumn('contact_1_email_source', (row) => (row.contact_1_email_result as any)?.email_source ?? null)
      .withColumn('contact_1_email_validated', (row) => (row.contact_1_email_result as any)?.email_validated ?? null)
      .withColumn('contact_2_name', (row) => (row.decision_makers as any[])?.[1]?.full_name ?? null)
      .withColumn('contact_2_title', (row) => (row.decision_makers as any[])?.[1]?.title ?? null)
      .withColumn('contact_2_linkedin', (row) => (row.decision_makers as any[])?.[1]?.linkedin ?? null)
      .withColumn('contact_2_email', (row) => (row.contact_2_email_result as any)?.email ?? null)
      .withColumn('contact_2_email_source', (row) => (row.contact_2_email_result as any)?.email_source ?? null)
      .withColumn('contact_2_email_validated', (row) => (row.contact_2_email_result as any)?.email_validated ?? null)
      .withColumn('fit_score', (row) => (row.assessment as any)?.fit_score ?? null)
      .withColumn('pain_score', (row) => (row.assessment as any)?.pain_score ?? null)
      .withColumn('total_score', (row) => {
        const a = row.assessment as any;
        return a ? Math.round((a.fit_score + a.pain_score) / 2) : null;
      })
      .withColumn('primary_pain', (row) => (row.assessment as any)?.primary_pain ?? null)
      .withColumn('pain_evidence', (row) => (row.assessment as any)?.pain_evidence ?? null)
      .withColumn('evidence_recency', (row) => (row.assessment as any)?.evidence_recency ?? null)
      .withColumn('size_band_guess', (row) => (row.assessment as any)?.size_band_guess ?? null)
      .withColumn('opener', (row) => (row.assessment as any)?.opener ?? null)
      .withColumn('status', (row) =>
        !row.assessment
          ? 'scoring_failed'
          : !(row.decision_makers as any[])?.length
            ? 'needs_contact'
            : !(row.contact_1_email_result as any)?.email
              ? 'needs_email'
              : 'ready',
      )
      .withColumn('miss_reason', (row) =>
        !(row.decision_makers as any[])?.length
          ? 'no owner/operator found in DropLeads or Deepline native search; try Apollo or the Maps contact email'
          : !(row.contact_1_email_result as any)?.email
            ? 'email waterfall found no mailbox-verified address'
            : null,
      )
      .run({
        key: 'business_id',
        description: 'Research, contact, score, and personalize each contractor account.',
        undrawnColumns: [
          'decision_makers',
          'contact_1_name', 'contact_1_title', 'contact_1_linkedin', 'contact_1_email', 'contact_1_email_source', 'contact_1_email_validated',
          'contact_2_name', 'contact_2_title', 'contact_2_linkedin', 'contact_2_email', 'contact_2_email_source', 'contact_2_email_validated',
          'fit_score', 'pain_score', 'total_score', 'primary_pain', 'pain_evidence', 'evidence_recency', 'size_band_guess',
          'opener', 'status', 'miss_reason',
        ],
      });

    // @mermaid-node out out:"$output"
    return { prospects, selected_count: selected.length };
  },
  {
    description:
      'AION October outbound: research US home-service contractors for lead/estimate/billing leak evidence, find decision-makers, score, and draft openers.',
    billing: { maxCreditsPerRun: 15 },
  },
);
