import body from '../skills/code-review/SKILL.md?raw';

// Embed resources in the standalone Runner bundle; deployments need no source tree.
export const reviewSkills = [{ name: 'code-review', body }] as const;
