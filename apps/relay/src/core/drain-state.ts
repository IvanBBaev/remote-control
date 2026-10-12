/**
 * Whether the relay is shutting down (D15). Set once on SIGTERM or when the app
 * starts closing; `/health` answers 503 from then on so no new traffic is routed here.
 */
export class DrainState {
  #draining = false;

  begin(): void {
    this.#draining = true;
  }

  isDraining(): boolean {
    return this.#draining;
  }
}
