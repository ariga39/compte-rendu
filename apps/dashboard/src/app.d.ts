/// <reference types="@cloudflare/workers-types" />
import type { ApplicationEnv } from './lib/server/application';
declare global {
  namespace Cloudflare {
    interface Env extends ApplicationEnv {}
  }
  namespace App {
    interface PageState {
      selectedTask?: string;
    }
  }
}

export {};
