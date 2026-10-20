import testQuality from '../skills/test-quality/SKILL.md?raw';
import testQualityLicense from '../skills/test-quality/LICENSE.md?raw';
import testQualityNotice from '../skills/test-quality/NOTICE.md?raw';
import errorHandling from '../skills/error-handling/SKILL.md?raw';
import errorHandlingLicense from '../skills/error-handling/LICENSE.md?raw';
import errorHandlingNotice from '../skills/error-handling/NOTICE.md?raw';
import workflowSecurity from '../skills/github-actions-security/SKILL.md?raw';
import workflowSecurityLicense from '../skills/github-actions-security/LICENSE.md?raw';
import workflowSecurityNotice from '../skills/github-actions-security/NOTICE.md?raw';
import misuseResistance from '../skills/security-misuse-resistance/SKILL.md?raw';
import misuseResistanceLicense from '../skills/security-misuse-resistance/LICENSE.md?raw';
import misuseResistanceNotice from '../skills/security-misuse-resistance/NOTICE.md?raw';

// Embed resources in the standalone Runner bundle; deployments need no source tree.
export const topicReviewSkills = [
  {
    name: 'test-quality',
    body: testQuality,
    license: testQualityLicense,
    notice: testQualityNotice,
  },
  {
    name: 'error-handling',
    body: errorHandling,
    license: errorHandlingLicense,
    notice: errorHandlingNotice,
  },
  {
    name: 'github-actions-security',
    body: workflowSecurity,
    license: workflowSecurityLicense,
    notice: workflowSecurityNotice,
  },
  {
    name: 'security-misuse-resistance',
    body: misuseResistance,
    license: misuseResistanceLicense,
    notice: misuseResistanceNotice,
  },
] as const;
