import type { ReviewDecision } from '@compte-rendu/contracts';

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
  body: `${formatReviewPublicationMarker(input.runId)}\n${input.markdown}`,
});
