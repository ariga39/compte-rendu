const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;

const isPublishableMarkdown = (markdown) =>
  typeof markdown === 'string' &&
  markdown.trim().length > 0 &&
  new TextEncoder().encode(markdown).byteLength <= MAX_MARKDOWN_BYTES &&
  markdown.trim().startsWith('## Review:');

export default {
  description: 'Submit the one final Markdown review for publication.',
  args: {
    markdown: {
      type: 'string',
      description:
        'The complete publishable Markdown review, beginning with exactly ## Review: after optional outer whitespace.',
    },
  },
  async execute(args) {
    if (!isPublishableMarkdown(args?.markdown)) {
      throw new Error(
        'Review Markdown must be non-empty, size-bounded, and begin with ## Review:.',
      );
    }
    return 'Review submitted.';
  },
};
