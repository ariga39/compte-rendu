export const formatReviewPublicationMarker = (runId: string) =>
  `<!-- compte-rendu:run:${runId} -->`;

export const formatReviewFailureComment = (runId: string) =>
  `Review failed before a result could be published. Please retry with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${runId} -->`;

export const formatReviewPublicationPayload = <HeadSha extends string>(input: {
  readonly runId: string;
  readonly headSha: HeadSha;
  readonly markdown: string;
}) => ({
  event: 'COMMENT' as const,
  commit_id: input.headSha,
  body: `${formatReviewPublicationMarker(input.runId)}\n${input.markdown}`,
});
