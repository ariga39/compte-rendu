import { JsonSchema, Option, Schema } from 'effect';
import { ReviewDecision, ReviewResult } from '@compte-rendu/contracts';

const FindingId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));

export const MultiFindingSchema = Schema.Struct({
  id: FindingId,
  location: Schema.NonEmptyString,
  claim: Schema.NonEmptyString,
  impact: Schema.NonEmptyString,
  evidence: Schema.NonEmptyString,
});
export type MultiFinding = typeof MultiFindingSchema.Type;

export const CoverageOutcome = Schema.Literals(['retained', 'merged', 'disagreement']);
export type CoverageOutcome = typeof CoverageOutcome.Type;

export const SynthesisCoverageSchema = Schema.Struct({
  findingId: FindingId,
  outcome: CoverageOutcome,
  finalId: Schema.optional(FindingId),
});
export type SynthesisCoverage = typeof SynthesisCoverageSchema.Type;

export const ReviewerSubmissionSchema = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
  findings: Schema.Array(MultiFindingSchema),
});
export type ReviewerSubmission = typeof ReviewerSubmissionSchema.Type;

export const SynthesisSubmissionSchema = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
  coverage: Schema.Array(SynthesisCoverageSchema),
});
export type SynthesisSubmission = typeof SynthesisSubmissionSchema.Type;

// The legacy single-review tool accepted optional provenance arrays beside the
// required decision and markdown; that contract is preserved unchanged.
export const SingleReviewSubmissionSchema = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
  findings: Schema.optional(Schema.Array(MultiFindingSchema)),
  coverage: Schema.optional(Schema.Array(SynthesisCoverageSchema)),
});
export type SingleReviewSubmission = typeof SingleReviewSubmissionSchema.Type;

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): Option.Option<S['Type']> =>
  Schema.decodeUnknownOption(schema, { onExcessProperty: 'error' })(value);

export const coverageProblem = (
  findings: readonly MultiFinding[],
  coverage: readonly SynthesisCoverage[],
): string | undefined => {
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) return 'duplicate-finding-id';
  const byFinding = new Map<string, SynthesisCoverage>();
  for (const entry of coverage) {
    if (byFinding.has(entry.findingId)) return 'duplicate-coverage';
    byFinding.set(entry.findingId, entry);
  }
  for (const id of ids) if (!byFinding.has(id)) return 'uncovered-finding';
  for (const entry of coverage) if (!ids.includes(entry.findingId)) return 'unknown-coverage';
  const retained = new Set(
    coverage
      .filter((entry) => entry.outcome === 'retained')
      .map((entry) => entry.finalId ?? entry.findingId),
  );
  for (const entry of coverage) {
    if (entry.outcome === 'retained' && entry.finalId === undefined) {
      return 'missing-final-id';
    }
    if (
      entry.outcome === 'merged' &&
      (entry.finalId === undefined || !retained.has(entry.finalId))
    ) {
      return 'invalid-merge-target';
    }
  }
  return undefined;
};

export const reviewerSubmissionProblem = (value: unknown): string | undefined =>
  Option.isSome(decodeStrict(ReviewerSubmissionSchema, value))
    ? undefined
    : 'Reviewer submissions must contain decision, markdown, and findings only.';

export const synthesisSubmissionShapeProblem = (value: unknown): string | undefined =>
  Option.isSome(decodeStrict(SynthesisSubmissionSchema, value))
    ? undefined
    : 'Supervisor submissions must contain decision, markdown, and coverage only.';

export const singleReviewSubmissionProblem = (value: unknown): string | undefined =>
  Option.isSome(decodeStrict(SingleReviewSubmissionSchema, value))
    ? undefined
    : 'Review submissions must contain decision and markdown, with optional findings or coverage.';

export const synthesisSubmissionProblem = (
  value: unknown,
  findings: readonly MultiFinding[],
): string | undefined => {
  const decoded = decodeStrict(SynthesisSubmissionSchema, value);
  if (Option.isNone(decoded)) {
    return 'Supervisor submissions must contain decision, markdown, and coverage only.';
  }
  return coverageProblem(findings, decoded.value.coverage);
};

// The tool executor sees a submission before the guard can attach its role, so
// this only proves the value matches exactly one role shape.
export const multiSubmissionProblem = (value: unknown): string | undefined => {
  const reviewer = Option.isSome(decodeStrict(ReviewerSubmissionSchema, value));
  const synthesis = Option.isSome(decodeStrict(SynthesisSubmissionSchema, value));
  if (reviewer !== synthesis) return undefined;
  return 'Multi-model submissions require findings (reviewer) or coverage (supervisor), not both.';
};

const inputSchema = (schema: Schema.Constraint): Record<string, unknown> => {
  const document = JsonSchema.resolveTopLevel$ref(
    Schema.toJsonSchemaDocument(schema, { generateDescriptions: true }),
  );
  return Object.keys(document.definitions).length === 0
    ? { ...document.schema }
    : { ...document.schema, $defs: document.definitions };
};

export const MultiReviewSubmissionSchema = Schema.Union([
  ReviewerSubmissionSchema,
  SynthesisSubmissionSchema,
]);
export type MultiReviewSubmission = typeof MultiReviewSubmissionSchema.Type;

export const multiReviewSubmissionInputSchema = inputSchema(MultiReviewSubmissionSchema);
export const singleReviewSubmissionInputSchema = inputSchema(SingleReviewSubmissionSchema);
