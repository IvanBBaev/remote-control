/** Where the CLI writes text for the user. Tests capture it in memory. */
export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}
