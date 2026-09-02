export const formatReviewPublicationMarker = (runId: string) =>
  `<!-- compte-rendu:run:${runId} -->`;

export const formatReviewPublicationPayload = <HeadSha extends string>(input: {
  readonly runId: string;
  readonly headSha: HeadSha;
  readonly markdown: string;
}) => ({
  event: 'COMMENT' as const,
  commit_id: input.headSha,
  body: `${formatReviewPublicationMarker(input.runId)}\n${input.markdown}`,
});
