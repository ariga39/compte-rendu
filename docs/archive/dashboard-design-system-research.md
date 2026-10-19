# Dashboard design-system research

> Archived research or implementation history. Its observations and recommendations
> describe the versions and decisions recorded below, not the current product contract.
> Use the [current documentation](../README.md) for supported behavior and operations.

Research date: 2026-10-16. Scope: a consistent design-system reference for the
read-only review dashboard. Baseline stack: SvelteKit 3, Svelte 5, Tailwind 4,
TypeScript. The research itself did not install packages or change application code.

## Recommendation

**Use IBM Carbon as the primary design-system reference.** Its documented table
anatomy, density, toolbar placement, content rules, and accessibility guidance
provide concrete decisions for a dashboard dominated by reviews and their states.
The selected implementation direction is Carbon Svelte, with self-hosted IBM Plex
Mono for all dashboard text. The compatibility checks below remain implementation
acceptance requirements; this research does not establish an integration pass.

Adopt one system's typography, spacing, colors, controls, and interaction patterns
together. Do not combine Carbon styling, Primer labels, and shadcn page layouts into
a new local design system.

## Candidates and evidence

| Candidate                                                                     | Relevant strengths                                                                                                                                                   | Implementation boundary                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [IBM Carbon](https://www.carbondesignsystem.com/components/data-table/usage/) | Explicit guidance for table anatomy, row density, toolbars, column labels, interaction and pagination.                                                               | A [Svelte implementation](https://github.com/carbon-design-system/carbon-components-svelte) exists, but its styles derive from Carbon v10; current central documentation must not be assumed to match it exactly. |
| [shadcn-svelte](https://www.shadcn-svelte.com/docs)                           | SvelteKit setup, reusable components, themes, and a concrete [Tasks example](https://www.shadcn-svelte.com/examples/tasks). Fits the existing Svelte/Tailwind stack. | A community Svelte port distributing component source, not a complete product interaction/content specification. A good lower-friction alternative if its existing example is the preferred visual direction.     |
| [GitHub Primer](https://primer.style/product/)                                | Product guidance, design tokens, page layouts, status labels and timeline components suited to developer products.                                                   | Its documented product component implementation is React; no official Svelte implementation was established in this research. Adopting the components would require additional integration work.                  |

Carbon's [Svelte README](https://github.com/carbon-design-system/carbon-components-svelte)
documents typed components, theme styles, and accessibility support. It explicitly
states that its compiled CSS uses vendored `carbon-components@10.58`. The repository's
[package manifest](https://github.com/carbon-design-system/carbon-components-svelte/blob/master/package.json)
uses Svelte 5 in development. This supports evaluating it, but does not prove
compatibility with this application's exact build or every component.

shadcn-svelte's [SvelteKit installation guide](https://www.shadcn-svelte.com/docs/installation/sveltekit)
and [Data Table guide](https://www.shadcn-svelte.com/docs/components/data-table)
provide an implementation route. Its table example uses TanStack Table. Neither
that dependency nor the example's selection, sorting, or page-number controls are
required merely to restyle the existing read-only dashboard.

## Applying the recommendation

- History: a structured review table with explicit columns, consistent row sizes,
  aligned timestamps, and a compact filter toolbar.
- Overview: concise counts and current reviews using the same typography and
  controls as History.
- Detail: review identity and outcome, a timeline, then grouped metadata; avoid a
  separate card for every timestamp.
- Use the selected system's standard controls, themes, spacing and focus treatments.
  Derive review status labels from recorded product semantics.
- Preserve server-side filtering and cursor navigation. Do not copy example
  controls that imply unsupported sorting, page counts, selection or mutations.
- Keep Help in Markdown and retain privacy expiry, automatic updates, keyboard
  navigation and mobile usability.

## Integration findings

The implementation uses `carbon-components-svelte@0.113.1`, its static g100 theme,
and `@fontsource/ibm-plex-mono@5.3.0`. Carbon replaces the previous Tailwind styling;
the unused Tailwind packages are removed. The project build, strict TypeScript and
Svelte checks, and all 41 browser tests pass with these versions. Component APIs
were checked against the installed package and the
[Svelte component documentation](https://svelte.carbondesignsystem.com/components/DataTable).

The packaged Carbon theme includes remote font declarations. A scoped build-time
transform removes those declarations so only local Plex Mono files are used.
Browser tests verify actual font loading and no external resource requests across
Overview, History, Help, and detail pages. The package's telemetry postinstall is
disabled through the existing pnpm build-script policy.

Library accessibility does not establish page accessibility. Verify focus,
headings, contrast and asynchronous updates in the composed dashboard, following
the [Carbon accessibility guidance](https://www.carbondesignsystem.com/components/data-table/accessibility/).
