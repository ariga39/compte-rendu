import { Sandbox } from '@cloudflare/sandbox';
import { withOpenCode, type OpenCodeHandle } from '@cloudflare/sandbox/opencode';

export class ReviewSandboxContainer extends Sandbox {
  readonly opencode: OpenCodeHandle;

  constructor(...args: ConstructorParameters<typeof Sandbox>) {
    super(...args);
    this.opencode = withOpenCode(this, { storage: args[0].storage });
  }
}
