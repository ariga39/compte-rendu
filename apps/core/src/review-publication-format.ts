import type { ReviewDecision } from '@compte-rendu/contracts';

const REVIEW_PUBLICATION_FOOTER =
  '\n\n---\n\n_AI reviews can be wrong. Treat these suggestions as guidance and use your judgment about which to accept._';

export const formatReviewPublicationMarker = (runId: string) =>
  `<!-- compte-rendu:run:${runId} -->`;

export const formatReviewFailureComment = (runId: string) =>
  `Review job failed. Check the reviews on this commit before retrying with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${runId} -->`;

export const formatReviewPublicationPayload = <HeadSha extends string>(input: {
  readonly runId: string;
  readonly headSha: HeadSha;
  readonly markdown: string;
  readonly decision?: ReviewDecision;
}) => ({
  event:
    input.decision === 'approve'
      ? ('APPROVE' as const)
      : input.decision === 'request_changes'
        ? ('REQUEST_CHANGES' as const)
        : ('COMMENT' as const),
  commit_id: input.headSha,
  body: `${formatReviewPublicationMarker(input.runId)}\n${input.markdown}${REVIEW_PUBLICATION_FOOTER}`,
});
