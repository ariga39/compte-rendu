// Dependency-free OpenCode 2 plugin that registers the single `submit_review`
// result tool. Runner writes the shared review submission contract bundle as
// ./contract.js and a mode constant ahead of this module.
import {
  multiReviewSubmissionInputSchema,
  multiSubmissionProblem,
  singleReviewSubmissionInputSchema,
  singleReviewSubmissionProblem,
} from './contract.js';

export default {
  id: 'submit-review',
  async setup(ctx) {
    // One successful submission per session. A rejected attempt is not recorded,
    // so an invalid call may be followed by one valid call.
    const submittedSessions = new Set();
    const multi = REVIEW_SUBMISSION_MODE === 'multi';
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'submit_review',
        options: { codemode: false },
        description: multi
          ? 'Submit the one final decision and Markdown. Reviewers also submit findings; the supervisor submits coverage instead.'
          : 'Submit the one final review decision and its publishable Markdown body.',
        input: multi ? multiReviewSubmissionInputSchema : singleReviewSubmissionInputSchema,
        async execute(input, context) {
          const problem = multi
            ? multiSubmissionProblem(input)
            : singleReviewSubmissionProblem(input);
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
