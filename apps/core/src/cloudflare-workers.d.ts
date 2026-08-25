declare module 'cloudflare:workers' {
  export type WorkflowEvent<T> = {
    readonly payload: Readonly<T>;
    readonly timestamp: Date;
    readonly instanceId: string;
    readonly workflowName: string;
  };

  export type WorkflowStepConfig = {
    readonly retries?: {
      readonly limit: number;
      readonly delay: number | `${number} ${string}`;
    };
    readonly timeout?: number | `${number} ${string}`;
  };

  export abstract class WorkflowStep {
    abstract do<T extends string>(
      name: string,
      config: WorkflowStepConfig,
      callback: () => Promise<T>,
    ): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Input = unknown> {
    protected readonly env: Env;
    protected constructor(ctx: ExecutionContext, env: Env);
    abstract run(event: WorkflowEvent<Input>, step: WorkflowStep): Promise<unknown>;
  }
}
