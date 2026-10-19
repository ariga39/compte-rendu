// Dependency-free OpenCode 2 plugin that registers the single `submit_review`
// result tool. Keep the size bound aligned with MAX_REVIEW_RESULT_BYTES in
// @compte-rendu/contracts whenever the publication bound changes.
const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;

const isPublishableMarkdown = (markdown) =>
  typeof markdown === 'string' &&
  markdown.trim().length > 0 &&
  new TextEncoder().encode(markdown).byteLength <= MAX_MARKDOWN_BYTES &&
  markdown.trim().startsWith('## Review:');

export default {
  id: 'submit-review',
  async setup(ctx) {
    // One successful submission per session. A rejected attempt is not recorded,
    // so an invalid call may be followed by one valid call.
    const submittedSessions = new Set();
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'submit_review',
        options: { codemode: false },
        description: 'Submit the one final review decision and its publishable Markdown body.',
        input: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['approve', 'request_changes', 'comment'],
              description: 'The review decision: approve, request_changes, or comment.',
            },
            markdown: {
              type: 'string',
              description:
                'The complete publishable Markdown review, beginning with exactly ## Review: after optional outer whitespace.',
            },
            findings: {
              type: 'array',
              description: 'Reviewer-only stable findings for multi-model provenance.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  location: { type: 'string' },
                  claim: { type: 'string' },
                  impact: { type: 'string' },
                  evidence: { type: 'string' },
                },
                required: ['id', 'location', 'claim', 'impact', 'evidence'],
                additionalProperties: false,
              },
            },
            coverage: {
              type: 'array',
              description:
                'Supervisor-only mapping from every reviewer finding id to its synthesis outcome.',
              items: {
                type: 'object',
                properties: {
                  findingId: { type: 'string' },
                  outcome: {
                    type: 'string',
                    enum: ['retained', 'merged', 'disagreement'],
                  },
                  finalId: { type: 'string' },
                },
                required: ['findingId', 'outcome'],
                additionalProperties: false,
              },
            },
          },
          required: ['decision', 'markdown'],
          additionalProperties: false,
        },
        async execute(input, context) {
          if (!isPublishableMarkdown(input?.markdown)) {
            throw new Error(
              'Review Markdown must be non-empty, size-bounded, and begin with ## Review:.',
            );
          }
          const sessionID = context?.sessionID;
          if (sessionID !== undefined) {
            if (submittedSessions.has(sessionID)) {
              throw new Error('A review was already submitted for this session.');
            }
            submittedSessions.add(sessionID);
          }
          return { content: 'Review submitted.' };
        },
      });
    });
  },
};
