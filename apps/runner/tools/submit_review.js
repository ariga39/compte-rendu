// Dependency-free OpenCode 2 plugin that registers the single `submit_review`
// result tool. Runner writes the shared review submission contract bundle as
// ./contract.js; the tool and Runner validate the same definition.
import { reviewSubmissionInputSchema, reviewSubmissionProblem } from './contract.js';

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
        input: reviewSubmissionInputSchema,
        async execute(input, context) {
          const problem = reviewSubmissionProblem(input);
          if (problem !== undefined) throw new Error(problem);
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
