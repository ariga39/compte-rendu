import { JsonSchema, Option, Schema } from 'effect';
import { ReviewDecision, ReviewResult } from '@compte-rendu/contracts';

// The publishable contract is one decision and one Markdown body. Multi-model
// orchestration is the supervisor's own concern; child reports are evidence,
// never a success gate.
export const ReviewSubmissionSchema = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
});
export type ReviewSubmission = typeof ReviewSubmissionSchema.Type;

// OpenCode normalizes the tool input before execute while the exported session
// keeps the raw call, so excess fields are ignored consistently on both sides.
export const reviewSubmissionProblem = (value: unknown): string | undefined =>
  Option.isSome(Schema.decodeUnknownOption(ReviewSubmissionSchema)(value))
    ? undefined
    : 'Review submissions must include a valid decision and Markdown.';

const inputSchema = (schema: Schema.Constraint): Record<string, unknown> => {
  const document = JsonSchema.resolveTopLevel$ref(
    Schema.toJsonSchemaDocument(schema, { generateDescriptions: true }),
  );
  return Object.keys(document.definitions).length === 0
    ? { ...document.schema }
    : { ...document.schema, $defs: document.definitions };
};

export const reviewSubmissionInputSchema = inputSchema(ReviewSubmissionSchema);
