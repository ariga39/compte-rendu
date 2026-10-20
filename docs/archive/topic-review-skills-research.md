# Topic-specific review skills research

> Archived research or implementation history. Its observations and recommendations
> describe the versions and decisions recorded below, not the current product contract.
> Use the [current documentation](../README.md) for supported behavior and operations.

Research date: 2026-10-20. Scope: issue
[#211](https://github.com/ariga39/compte-rendu/issues/211) only. No skill was
installed, no prompt/runtime was changed, and no other repository file was edited.
External sources are pinned to the commits named below. This is a content and fit
review, not a benchmark of review quality.

## Recommendation

Start with three narrow, on-demand topic skills:

1. `security-misuse-resistance`, derived from Trail of Bits `sharp-edges`, if the
   CC-BY-SA-4.0 obligations are accepted.
2. `postgres-review`, a narrowed review adaptation of Supabase's Postgres best
   practices.
3. `web-accessibility`, a vendored accessibility/interaction subset of Vercel's
   Web Interface Guidelines.

Trail of Bits `differential-review` should **not** become a topic skill. It is a
whole-review workflow and report generator, not a domain method that supplements
the shared prompt. It also permits write access and Bash, and can require
repository checkouts, subagents and a report file, none of which fit the current
static read-only Sandbox.

The Vercel `web-design-guidelines` wrapper should **not** be adopted as-is. It
fetches mutable rules from `main` with WebFetch, and it defines its own output
format. The underlying Web Interface Guidelines content is usable only after it is
pinned, vendored, and stripped of fetch/output instructions.

Do not add a generic `pr-review` skill, a per-language bundle, or a mechanical
file-extension dispatcher. Topic selection should follow the changed surface and
behaviour.

## Decision frame

Issue #211 asks for one topic per skill and separates three layers:

- **Shared prompt:** review scope, exact revision, context collection, finding
  criteria, confidence gate, decision, publication boundary, and final output.
  The current design names `apps/runner/src/review-prompt.ts` as the single source
  for these ([design](../design.md), lines 217–223).
- **Topic skill:** domain-specific questions, failure modes, detection patterns
  and references that improve inspection of a particular surface.
- **Runtime/security:** Sandbox, tool allowlist, egress, credentials, cleanup and
  publication. A skill cannot extend these.

The current static review contract prohibits executing repository code, editing
files, installing dependencies, builds/tests/hooks, and publication. It allows
native read/grep/glob plus direct `gh pr view`, `gh api graphql`, `git diff`,
`git grep`, `git log`, and `git show` commands
([review-prompt.ts](../../apps/runner/src/review-prompt.ts), lines 23–32). The
agent is read-only and repository text is untrusted evidence
([design](../design.md), lines 211–215).

Consequences for this research:

- A topic skill must be plain Markdown that works with file reads and the existing
  Git/GitHub inspection commands. It must not require scripts, package installs,
  network fetches, execution, writes, or publication.
- A topic skill must not redefine output, severity, finding count or decision.
  Those remain shared-prompt rules.
- If a source's method asks for execution or proof-by-running, it must be reduced
  to static evidence or omitted.
- Applicability must be behaviour-based. A `.sql` file can be D1, not Postgres; a
  `.tsx` file can be a server module, not UI. File extension is not a dispatcher.

## Candidate summary

| Candidate                                    | What it actually is                                                                              | Domain method retained?                                         | Static Sandbox fit                                                           | Verdict                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Trail of Bits `differential-review`          | Full security-review workflow, baseline checkout, git blame, blast radius, subagent, report file | Mostly orchestration; a little domain material                  | No: `Write`/`Bash`, `git checkout`, `find`, subagents, mandatory file output | Reject as a topic skill        |
| Trail of Bits `sharp-edges`                  | Misuse-resistant API/configuration analysis                                                      | Yes: footguns, unsafe defaults, type confusion, silent failures | Yes after removing proof-by-writing/execution                                | Adopt, conditional on licence  |
| Supabase `supabase-postgres-best-practices`  | Prioritised Postgres rules with SQL examples                                                     | Yes: schema, queries, indexes, RLS, locks, pooling              | Yes: Markdown/SQL reference; no execution required                           | Adopt a narrowed review subset |
| Vercel `web-design-guidelines` wrapper       | Thin instruction to WebFetch a mutable URL                                                       | No: the wrapper has no rules                                    | No: WebFetch is unavailable and upstream is unpinned                         | Reject wrapper                 |
| Vercel Web Interface Guidelines `command.md` | About 100 concrete UI/accessibility rules plus an output format                                  | Yes, for accessibility/interaction                              | Yes only when vendored; output section must be removed                       | Adopt an accessibility subset  |

## Trail of Bits security skills

Pinned source: commit
[`5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0`](https://github.com/trailofbits/skills/commit/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0)
(2026-10-15). Repository licence:
[CC-BY-SA-4.0](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/LICENSE).

### `differential-review` is not a topic skill

The primary security candidate advertises a security-focused differential review
with adaptive depth, git blame, blast-radius counting, test-coverage checks and a
Markdown report
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L1-L10)).
It requires `Read Write Grep Glob Bash`
([frontmatter](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L4)).
It mandates a report file
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L17),
[checklist](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L106-L116)),
delegates to a namespaced subagent
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L94-L102)),
and prescribes a full executive-summary/severity/report template
([reporting.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/reporting.md#L1-L50)).
Its methodology also performs `git checkout`, `find`, `git blame`, `gh pr view`
and baseline analysis
([methodology.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/methodology.md#L1-L40)).

What remains genuinely domain-specific is narrower: security regressions,
blast-radius thinking, attacker modelling and some vulnerability patterns.
Those do not justify importing the workflow. The shared prompt already covers
exact-revision scope, callers, history, adversarial review and concise output;
the report template would create a second output contract.

**Verdict:** reject for the initial set. Reading `patterns.md` or
`adversarial.md` for ideas is possible, but neither should become a skill entry
point.

### `sharp-edges` is the better security candidate

`sharp-edges` is a true topic method: it asks whether APIs, configurations and
interfaces make insecure use the easy path
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md#L1-L17)).
Its retained categories are concrete:

- algorithm/mode selection footguns, including JWT `alg` confusion;
- dangerous defaults and zero/empty/null semantics;
- primitive-versus-semantic APIs and type confusion;
- configuration cliffs and precedence/combination hazards;
- silent security failures;
- stringly-typed security values.

Representative references support these categories with examples:
[config-patterns.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/references/config-patterns.md),
[crypto-apis.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/references/crypto-apis.md),
[auth-patterns.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/references/auth-patterns.md),
and [lang-javascript.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/references/lang-javascript.md).
The language references are useful only when the changed code uses that language;
they should not all be loaded for every security change.

**Static compatibility:** the frontmatter allows only `Read Grep Glob`
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md#L4)),
which fits the Sandbox. However, its “Validate Findings” phase says to write
minimal code and test mitigations
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md#L235-L242)).
That must be rewritten as static validation: trace the changed call path and
existing configuration/tests, and drop or qualify a finding when proof would need
execution.

**Quality caveat:** some detection rules are intentionally broad heuristics, not
proof. For example, “any numeric security parameter that accepts 0” is a prompt
to investigate, not a defect by itself. The shared prompt's caused-by-this-diff
and concrete-consequence gates must remain authoritative. The skill's own
severity table
([SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md#L246-L253))
should not become a second severity system.

**Licence:** CC-BY-SA-4.0 is a share-alike content licence. Copying or adapting
the skill text or references requires attribution and licensing of the adaptation
under the same terms. That is a product/licensing decision, not a technical one.
If those obligations are unacceptable, do not vendor the text; write independent
rules and cite the source as background. This is not legal advice.

## Supabase Postgres best practices

Pinned source: commit
[`c9be0e931b7930f7d02126d04774d904c381e7d7`](https://github.com/supabase/agent-skills/commit/c9be0e931b7930f7d02126d04774d904c381e7d7)
(2026-10-02). Licence:
[MIT](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/LICENSE),
copyright 2026 Supabase.

The skill describes itself as Postgres best practices “for Postgres running
anywhere”, with eight categories: query performance, connection management,
security/RLS, schema design, concurrency/locking, data access, monitoring and
advanced features
([SKILL.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md#L1-L38)).
Its references are short Markdown rule files with incorrect/correct SQL,
explanations and upstream references
([SKILL.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md#L40-L64)).

**Domain methods, not orchestration.** This is the cleanest fit of the three
sources. It is static reference material: no scripts, execution, writes or
publication. Sample rules cover idempotent constraint migrations
([schema-constraints.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/schema-constraints.md#L1-L35)),
RLS policy performance and `SECURITY DEFINER` cautions
([security-rls-performance.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/security-rls-performance.md#L1-L50)),
deadlock avoidance through lock ordering
([lock-deadlock-prevention.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/lock-deadlock-prevention.md#L1-L45)),
data-type choices
([schema-data-types.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/schema-data-types.md#L1-L44)),
and indexes on filtered/joined columns
([query-missing-indexes.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/query-missing-indexes.md#L1-L35)).

**Spot checks against primary documentation.** PostgreSQL's `ALTER TABLE`
reference confirms the correct `ADD table_constraint` form and does not provide
`ADD CONSTRAINT IF NOT EXISTS`
([PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)).
PostgreSQL's character-type documentation states that `text`, `varchar` without a
limit, and `varchar(n)` have no performance difference apart from storage and
length-check overhead
([PostgreSQL character types](https://www.postgresql.org/docs/current/datatype-character.html)).
Supabase's RLS documentation independently describes wrapping `auth.uid()` in a
`select` so the optimizer can run it as an initPlan per statement rather than per
row ([Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)).
Those checks support the sampled rules but do not validate every rule file.

**Quality caveats:**

- The trigger description is authoring-oriented (“load BEFORE writing or changing
  anything”), not review-oriented
  ([SKILL.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md#L3)).
  It must be rewritten for review use.
- Some rules are Supabase-specific (`auth.uid()`, exposed schemas) even though the
  headline says “Postgres running anywhere”. Do not present those as universal
  Postgres requirements.
- Some statements are contextual absolutes. “Always index the foreign key side”
  and “add an index on WHERE/JOIN columns” are useful prompts, but a review must
  consider write cost, selectivity and the actual access path. Performance
  multipliers such as “100x+” in the RLS reference are illustrative, not
  guarantees
  ([RLS performance](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references/security-rls-performance.md#L4-L27)).
- At the pin, the skill metadata says version `1.1.1`
  ([SKILL.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md#L4-L9))
  while the changelog's latest entry is `1.6.0`
  ([CHANGELOG.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/CHANGELOG.md#L1-L16)).
  Treat the pinned content as the source, not the version label. The
  `_sections.md` helper also retains template instructions (“Take the examples
  below as pure demonstrative…”), so do not ship the reference bundle unedited.
- No execution is needed, but that also means a review cannot run `EXPLAIN` or
  inspect a live `pg_stat_statements`. Rules that depend on runtime plans must be
  expressed as static questions or omitted.

**Adaptation:** keep one skill for Postgres changes, with a compact index and only
the matching category references. Narrow the description to review triggers, strip
the authoring “before writing” instruction, distinguish Supabase-specific notes,
and require the shared concrete-consequence gate before reporting an index,
pooling or datatype concern.

## Vercel web design/accessibility

Two different artefacts exist and should not be conflated.

### The wrapper is not usable as-is

Pinned wrapper: commit
[`063bee94c3f4df8453406c830b0a7df0f2860278`](https://github.com/vercel-labs/agent-skills/commit/063bee94c3f4df8453406c830b0a7df0f2860278)
(2026-08-28). The repository has no `LICENSE` file at this pin, although its
README says “MIT”
([README](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md#L237-L239)).
The wrapper itself contains no domain rules. It tells the agent to fetch
`raw.githubusercontent.com/.../main/command.md`, apply it, and emit a terse
`file:line` output
([SKILL.md](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md#L14-L37)).

That fails three ways for this product: WebFetch is not in the static contract;
`main` is mutable and unpinned; and the wrapper's output format conflicts with the
shared prompt's Markdown/decision output. Do not adopt the wrapper.

### The underlying guidelines are usable after adaptation

Pinned content: Web Interface Guidelines commit
[`434b7f91364665f2f733b310ec54809bf8f37937`](https://github.com/vercel-labs/web-interface-guidelines/commit/434b7f91364665f2f733b310ec54809bf8f37937)
(2026-10-05). Licence:
[MIT](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/LICENSE),
copyright 2025 Vercel Labs.

`command.md` contains concrete, mostly framework-agnostic rules for accessibility,
focus, forms, animation, typography, content handling, images, performance,
navigation/state, touch, layout, theming, i18n and hydration
([command.md](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md#L12-L167)).
Useful review rules include keyboard operation, visible focus, semantic
buttons/links, labels, inline errors, reduced motion, hit targets, URL state and
accessible names. The rules align with WCAG 2.2 concerns such as contrast
([WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html))
and visible focus
([WCAG 2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)).

The source also states that it is a living, non-exhaustive list
([README](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/README.md#L3))
and separates universal guidance from explicitly Vercel-specific brand choices
([README](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/README.md#L144-L146)).
Do not import the Vercel copywriting/design preferences as review blockers.

**Adaptation:**

- Vendor a pinned subset; do not fetch at review time.
- Keep accessibility, focus/keyboard, semantic HTML, forms, media, motion,
  responsive/safe-area and interaction-state rules.
- Drop typography taste, Vercel copy rules, visual-design opinions, and the
  `command.md` output format
  ([output format](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md#L169-L191)).
- Use WCAG 2.2 AA as the baseline. The same source's preference for APCA over WCAG
  contrast
  ([README](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/README.md#L137))
  is a design-quality recommendation, not a conformance substitute.
- Do not claim the skill can measure rendered contrast or test keyboard flows.
  Static evidence can identify missing labels, handlers, focus styles, semantics,
  dimensions and reduced-motion omissions; anything requiring a browser run must
  remain an evidence limitation.

A dedicated `accessibility-best-practices` skill did exist in the Vercel Labs
repository at commit
[`b76f5b5`](https://github.com/vercel-labs/agent-skills/blob/b76f5b5fe518dad4bada08608edd069ce70a4e3c/skills/accessibility-best-practices/SKILL.md)
(2026-02-02), with 48 rules and WCAG citations. It is absent from the current main
tree at `063bee94`. Do not pin to a removed, unmaintained skill when the current
guidelines repository is MIT-licensed and still maintained.

## Recommended initial set

| Skill concept                | Source                          | Proposed applicability description                                                                                                                                                                                                                                | Required adaptation                                                                                                    | Licence                   |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `security-misuse-resistance` | ToB `sharp-edges`               | Use when the diff changes authentication, authorization, sessions/tokens, secret validation, cryptography, security-relevant defaults/configuration, or a public API that lets callers choose security behaviour. Do not use for general correctness or every PR. | Static-only validation; no subagent, report, execution or new severity system; treat rules as hypotheses               | CC-BY-SA-4.0, conditional |
| `postgres-review`            | Supabase best practices         | Use when the diff changes Postgres schema/migrations, constraints, indexes, queries/plans, RLS/grants, transactions/locking, connection pooling, or Postgres extensions. Do not use for D1/SQLite, generic SQL, or unrelated application code.                    | Review-oriented trigger; bundle only matching refs; distinguish Supabase-specific rules; no live EXPLAIN/DB inspection | MIT                       |
| `web-accessibility`          | Vercel Web Interface Guidelines | Use when the diff changes user-facing markup/components, forms, dialogs, navigation, focus/keyboard behaviour, ARIA, images/media, or visible styling in HTML/React/Next.js/Svelte/Vue. Do not use for server-only changes or house-style copy and visual taste.  | Vendor pinned accessibility subset; remove WebFetch and output format; WCAG AA baseline                                | MIT                       |

Why this is small enough:

- The three skills cover distinct surfaces: security-sensitive behaviour, Postgres
  data changes, and web accessibility. They do not cover all of security, all of
  design, or all of performance.
- `postgres-review` deliberately excludes D1/SQLite. For this repository's own
  D1 work it will not load; for target repositories using Postgres it can.
- `security-misuse-resistance` overlaps the shared prompt's general security
  instruction. Its unique value is the misuse-resistant API/config lens, not a
  second security review.
- When security and Postgres both apply, the Postgres skill owns database-specific
  RLS/privilege detail; the security skill should not duplicate it.
- No generic concurrency, performance, C/Rust review, design-system, docs/style or
  “find bugs” skill in the initial set. Add those only after observed review
  demand and a similarly focused source.

### Interaction with the shared prompt

All three should be written as subordinate checklists:

- Start from the shared exact revision and changed-behaviour scope.
- Add only domain-specific questions and evidence patterns.
- Do not require a finding per rule, a fixed number of sections, or a separate
  report.
- Do not add tools, shell commands, network access, writes, installation or
  publication.
- Feed candidates into the shared confidence and consequence gate.
- Keep the shared `TLDR:`, decision and concise Markdown output. A topic skill that
  asks for “terse file:line findings” or an executive report is malformed for this
  product.

## Evidence limitations

- This review inspected complete primary `SKILL.md` files and representative
  references, not every file in each repository. For Trail of Bits, the sampled
  files were `differential-review` (SKILL, methodology, adversarial, patterns,
  reporting) and `sharp-edges` (SKILL, config, crypto, auth, JavaScript
  references), plus `fp-check` as a rejection check. For Supabase, the sampled
  rules were schema constraints, RLS basics/performance, query missing indexes,
  lock deadlock prevention, data types, connection pooling, pagination and
  privileges. For Vercel, the sampled content was the wrapper, `command.md`, the
  current guidelines README/AGENTS, and several archived accessibility rules.
- No skill was executed or benchmarked against real PRs. Static compatibility is
  inferred from the source instructions and the current prompt/tool contract, not
  demonstrated end to end.
- Content quality judgments are based on specificity, evidence and fit, not
  repository popularity. GitHub stars, install counts and vendor reputation were
  not used as quality evidence.
- Supabase's performance multipliers and some absolute index/datatype rules were
  not independently measured. Spot checks covered a small number of claims against
  PostgreSQL and Supabase primary documentation.
- Licence statements are factual source observations, not legal advice.
- The Vercel accessibility skill was removed from `main`; its historical content
  was inspected only to avoid recommending a stale duplicate. The Vercel wrapper
  repository lacks a `LICENSE` file at the pin, so the licensed guidelines
  repository is the safer content source.

## Pinned sources

- Issue: [Research topic-specific review skills loaded on demand (#211)](https://github.com/ariga39/compte-rendu/issues/211).
- Trail of Bits: [commit](https://github.com/trailofbits/skills/commit/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0),
  [licence](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/LICENSE),
  [`differential-review`](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md),
  [`sharp-edges`](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md),
  [`fp-check`](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/fp-check/skills/fp-check/SKILL.md).
- Supabase: [commit](https://github.com/supabase/agent-skills/commit/c9be0e931b7930f7d02126d04774d904c381e7d7),
  [licence](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/LICENSE),
  [SKILL.md](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md),
  [references](https://github.com/supabase/agent-skills/tree/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/references).
- Vercel wrapper: [commit](https://github.com/vercel-labs/agent-skills/commit/063bee94c3f4df8453406c830b0a7df0f2860278),
  [SKILL.md](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md),
  [README licence statement](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md#L237-L239).
- Vercel guidelines: [commit](https://github.com/vercel-labs/web-interface-guidelines/commit/434b7f91364665f2f733b310ec54809bf8f37937),
  [licence](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/LICENSE),
  [command.md](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md),
  [README](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/README.md).
- Removed Vercel accessibility skill: [pinned historical SKILL.md](https://github.com/vercel-labs/agent-skills/blob/b76f5b5fe518dad4bada08608edd069ce70a4e3c/skills/accessibility-best-practices/SKILL.md).
