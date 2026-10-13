/** Asks the user at the terminal (pairing confirmation, D6). */
export interface Prompt {
  /** Resolves true only for an explicit yes; false for anything else or on `signal`. */
  confirm(question: string, signal: AbortSignal): Promise<boolean>;
}
