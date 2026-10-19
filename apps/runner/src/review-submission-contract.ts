import { Option, Schema } from 'effect';
import { ReviewDecision, ReviewResult } from '@compte-rendu/contracts';

// The publishable contract is one decision and one Markdown body. Multi-model
// orchestration is the supervisor's own concern; child reports are evidence,
// never a success gate.
export const ReviewSubmissionSchema = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
});
export type ReviewSubmission = typeof ReviewSubmissionSchema.Type;

export const parseReviewSubmission = (text: string): ReviewSubmission | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(ReviewSubmissionSchema))(text),
  );
