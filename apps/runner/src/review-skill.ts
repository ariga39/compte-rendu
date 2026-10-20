import body from '../skills/code-review/SKILL.md?raw';
import license from '../skills/code-review/LICENSE.md?raw';
import notice from '../skills/code-review/NOTICE.md?raw';

// Embed resources in the standalone Runner bundle; deployments need no source tree.
export const reviewSkills = [{ name: 'code-review', body, license, notice }] as const;
