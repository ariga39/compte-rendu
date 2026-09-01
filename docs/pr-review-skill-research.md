# PR review skill source synthesis

Research date: 2026-08-26. Sources are pinned to the commits current at research time.

## Source 1: poi OpenCode review workflow

Primary source: [`opencode-review.yml`](https://github.com/poooi/poi/blob/87780129a3ba6b20d852d546518a5469c01439f5/.github/workflows/opencode-review.yml) ([raw](https://raw.githubusercontent.com/poooi/poi/87780129a3ba6b20d852d546518a5469c01439f5/.github/workflows/opencode-review.yml)).

### Exact source requirements

The review prompt requires the model to ([lines 65–86](https://github.com/poooi/poi/blob/87780129a3ba6b20d852d546518a5469c01439f5/.github/workflows/opencode-review.yml#L65-L86)):

- inspect adversarially for concrete correctness, security, permission, reliability, CI, performance, and long-term maintenance failures;
- double-check every candidate: the PR caused it, it is reachable or materially risky, it merits requesting changes, it is not already covered, and it is not speculative, low-impact, duplicate, or mainly subjective;
- report only high-confidence findings, prefer no finding to a weak one, cap the result at five findings, and order them by severity;
- include the concrete risk, relevant changed line or behavior, and smallest practical fix for each finding;
- omit style, formatting, naming, and preference comments unless they cause a concrete bug, security problem, or clearly explainable maintenance risk; and
- never modify files, commit, or push.

The surrounding workflow also skips draft PRs, checks that the triggering actor has write/admin permission, cancels stale runs for the same PR, imposes a 15-minute job timeout, checks out without persisted credentials, disables OpenCode session sharing, and grants only the GitHub permissions needed to read code and publish review output ([lines 6–63](https://github.com/poooi/poi/blob/87780129a3ba6b20d852d546518a5469c01439f5/.github/workflows/opencode-review.yml#L6-L63)). Those are workflow controls, not reviewer reasoning instructions.

### OpenCode permission ordering

The [pinned OpenCode permissions guidance](https://github.com/anomalyco/opencode/blob/0a5bed2bc2549d988ba969765ec6722615c56e01/packages/web/src/content/docs/permissions.mdx#L68-L91) states: “Granular rules are last-match-wins, so catch-all must precede specific allows.”

### Adaptation recommendations (superseded by issue #86)

The following recommendations record the earlier static-only adaptation. They
remain source-history facts, but are no longer the product contract: issue #86
chooses a fully YOLO OpenCode reviewer in an isolated Docker microVM with a
scoped GitHub read capability.

- Keep the source's adversarial categories as a search checklist, not as output headings; output only defects that survive its confidence gate.
- Strengthen “caused by this PR” into an exact target contract: inspect only the caller-supplied `baseSha..headSha`, and anchor every finding to a head-side changed line. Necessary call sites, types, configuration, and tests may be read only to validate reachability.
- Preserve “at most five, severity ordered,” but do not force a finding for every category or invent severity labels unless the product schema supports them.
- Make every message compact and complete: **risk → evidence/reachability → smallest fix**. Do not emit analysis narration.
- [Superseded] Keep repository mutation prohibited. The earlier static Sandbox
  adaptation also prohibited dependency installation, package-manager use,
  builds, tests, hooks, plugins, MCP, repository programs, and web access;
  these were project adaptations, not requirements from `poi`.
- [Superseded by issue #105] Retain the project's earlier bare, schema-valid
  JSON output contract. The selected product output is instead one concise,
  human-readable Markdown review without a rigid format; the `poi` source
  still supplies useful finding-quality principles but does not require JSON,
  a particular schema, or head-side line anchoring.

## Source 2: i-have-adhd skill

Primary source: [`SKILL.md`](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md) ([raw](https://raw.githubusercontent.com/ayghri/i-have-adhd/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md)).

### Exact source principles relevant here

- Put the actionable answer first rather than opening with context or a plan ([lines 33–40](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L33-L40)).
- Use the fewest bounded items that still work; cap a list at five and rank it instead of returning a long unranked list ([lines 42–46](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L42-L46), [103–105](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L103-L105)).
- Suppress tangents: finish the primary issue without appending unrelated side issues ([lines 64–71](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L64-L71)).
- State errors matter-of-factly as cause and fix, without emotional filler ([lines 96–101](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L96-L101)).
- Remove preambles, completed-work recaps, closing pleasantries, empty hedges, idioms, and figurative language. Keep hedging only when it carries real uncertainty ([lines 107–115](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L107-L115), [128–136](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L128-L136)).
- Let the task and higher-level harness constraints override formatting rules when brevity would remove necessary substance ([lines 117–126](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L117-L126)).

The source also defines session persistence, numbered user task plans, repeated state reminders, time estimates, visible-progress cues, and a concrete next action at the end ([lines 15–19](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L15-L19), [42–94](https://github.com/ayghri/i-have-adhd/blob/cbe69fb83c08a37cf54d5ec9ec6bb88c8bc9973c/skills/i-have-adhd/SKILL.md#L42-L94)). Those instructions serve an interactive ADHD-oriented assistant and are not intrinsically part of code-review judgment.

### Adaptation recommendations

- Apply the principles to each finding rather than importing the source's persona or session workflow: begin with the defect and impact, then give only the evidence needed to establish it, and end with the smallest practical fix.
- Keep the summary to the PR's actual behavior, overall verdict, and the most consequential result. Do not repeat every finding or narrate the review process.
- Treat `poi`'s five-finding cap as the outer limit, not a target. Fewer, stronger findings are better.
- Do not add interactive next-step prompts, time estimates, progress narration, motivational language, or “ADHD mode” persistence to an autonomous review result.
- Preserve uncertainty only where evidence is incomplete; otherwise use direct cause/effect wording. If a concern cannot be made concrete and actionable in a short finding, omit it.

### 2026-09-01 current-source addendum: verdict and finding count first

Current upstream `main` is commit
[`284a2013ae313405382a0c8a88b0cb64fd1543c5`](https://github.com/ayghri/i-have-adhd/commit/284a2013ae313405382a0c8a88b0cb64fd1543c5);
the source used here is its commit-pinned
[`SKILL.md`](https://github.com/ayghri/i-have-adhd/blob/284a2013ae313405382a0c8a88b0cb64fd1543c5/skills/i-have-adhd/SKILL.md).

The source directly requires the answer rather than context or a plan to come
first ([lines 33–40](https://github.com/ayghri/i-have-adhd/blob/284a2013ae313405382a0c8a88b0cb64fd1543c5/skills/i-have-adhd/SKILL.md#L33-L40)),
forbids preambles and says to “Start with the answer”
([lines 107–115](https://github.com/ayghri/i-have-adhd/blob/284a2013ae313405382a0c8a88b0cb64fd1543c5/skills/i-have-adhd/SKILL.md#L107-L115)),
and asks whether the first line alone makes the state clear
([lines 128–140](https://github.com/ayghri/i-have-adhd/blob/284a2013ae313405382a0c8a88b0cb64fd1543c5/skills/i-have-adhd/SKILL.md#L128-L140)).
For a review, the answer is whether actionable defects exist. This directly
supports making a no-findings verdict obvious before any explanation.

The upstream source does **not** mention code-review verdicts or require an
exact finding count in the first sentence. That count is a justified project
adaptation of its answer-first and bounded-list principles, not a verbatim
upstream rule. Before issue #118, the project skill only asked for a short
overall conclusion and said to state no findings plainly; it did not require
either to appear first or require an exact count.

Exact adaptation recommendation: after the required `## Review:` heading, make
the first publishable sentence one of `No actionable findings.` or
`Found N actionable findings.` (with the exact integer `N`, 1–5). Put any PR
description, evidence, and finding details after that sentence. For a
no-findings review, end there unless a short explanation materially helps; the
reader must never have to read the explanation to discover that the count is
zero.

## Combined contract for this project (historical static-only adaptation; superseded by issues #86 and #105)

The dedicated reviewer skill should say, in substance:

1. Load the exact caller-supplied base/head diff and statically inspect changed code plus only the context needed to prove reachability.
2. Search adversarially, then discard anything not introduced by the diff, not materially reachable, already covered, subjective, duplicate, speculative, or too weak to request a change.
3. Return zero to five findings ordered by severity; each is anchored to a head-side changed line and says only the concrete risk, decisive evidence, and smallest practical fix.
4. [Superseded] Do not modify or execute the repository, install dependencies,
   run package managers/builds/tests/hooks/plugins/MCP, or use the web. The
   current #86 contract permits the YOLO reviewer to use whatever tools
   materially help inside the isolated microVM.
5. [Superseded by issue #105] Emit exactly one bare schema-valid JSON object.
   The selected product output is one concise human-readable Markdown review
   with useful findings and a short conclusion, without a rigid template or
   artificial formatting requirements.

## Historical issue #86 decision (superseded by issue #105)

The current product contract runs OpenCode fully YOLO in the isolated Docker
microVM: there is no OpenCode tool allowlist or approval prompt. The reviewer
has direct GitHub read capability through the single-repository, read-only
token available to the Sandbox, and the prompt/skill require complete current
pull-request context before reviewing the exact base/head pair. Agent output,
GitHub responses, and repository text are untrusted evidence. Exact SHA
verification and current-head publication checks remain required. Issue #105
supersedes the bare JSON output with the final Markdown review selected above.

Security is provided by external boundaries: no sensitive host mounts or host
skills/MCP/SSH-agent sharing, the scoped token and `api.github.com` network
policy, the `opencode.ai` network policy, fixed CPU/memory/deadline limits, and
terminal Sandbox, secret, temporary-source, and network-policy cleanup. YOLO
tool access does not grant publication authority.

## Real E2E correction

This section preserves the historical static-only E2E findings. Its
static-only permission adaptation is superseded by issue #86; the current
security boundary is the external Sandbox, scoped token, network policy,
resource/deadline, and cleanup contract.

A real E2E against head `ca436a414763995924cd79412752d63f9f514477` returned a preamble and Markdown-fenced JSON, so the Runner correctly failed it as `invalid-output`; durable local-only evidence was retained outside the repository. It also showed that `git diff/show --output` can write and `git diff --no-index` can read outside the checkout. The correction keeps only `git diff`, `git show`, and `git grep` bash allows, places later-match denies for `git diff*--output*`, `git show*--output*`, and `git diff*--no-index*`, and removes bash `grep`/`rg` allows because native OpenCode grep/read/glob remain available.

A corrected historical E2E at head `cbe60f1` succeeded with one bare JSON
result. Independent OpenCode source validation accepted only the
command-boundary/redirect finding and rejected the compound-operator and
writable-XDG conclusions; this result predates the issue #105 Markdown output
decision.
