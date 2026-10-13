/** A media query the layout follows, injected so tests pick the screen width. */
export interface MediaQuery {
  readonly matches: () => boolean;
  /** Calls `onChange` whenever `matches()` flips; returns the unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
}
