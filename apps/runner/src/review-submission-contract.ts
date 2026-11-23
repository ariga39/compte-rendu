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

const DecisionHeader = /^DECISION: (approve|request_changes|comment)\r?\n\r?\n/;
const decodeSubmission = Schema.decodeUnknownOption(ReviewSubmissionSchema);

export const parseReviewSubmission = (text: string): ReviewSubmission | undefined => {
  const json = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(ReviewSubmissionSchema))(text),
  );
  if (json !== undefined) return json;
  const header = DecisionHeader.exec(text);
  if (header === null) return undefined;
  return Option.getOrUndefined(
    decodeSubmission({
      decision: header[1],
      markdown: text.slice(header[0].length),
    }),
  );
};
