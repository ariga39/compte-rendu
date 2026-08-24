export interface WorkerEntrypoint {
  fetch(request: Request): Response | Promise<Response>;
}
