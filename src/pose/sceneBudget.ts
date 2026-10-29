import { SceneError } from "./sceneContract.js";

/** One deadline for the entire scene request, including source checks and publication. */
export class SceneBudget {
  readonly signal: AbortSignal;
  constructor(timeoutMs: number, parent?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000)
      throw new Error("scene deadline must be within the staging request budget");
    const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
    this.signal = parent ? AbortSignal.any([deadline, parent]) : deadline;
  }
  check() {
    if (this.signal.aborted)
      throw new SceneError("SCENE_TIMEOUT", "scene request deadline reached", true);
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new SceneError("SCENE_TIMEOUT", "scene request deadline reached", true));
      this.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => { this.check(); return operation(); }).then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", aborted));
    });
  }
}
