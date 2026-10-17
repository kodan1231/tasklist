import type { TaskStore } from "./store";

export interface Env {
  TASKS: DurableObjectNamespace<TaskStore>;
  ASSETS: Fetcher;
}
