/** Slow, salted hashing for secrets a person keeps (the recovery code, 02 §5.5). */
export interface SecretHasher {
  /** A self-describing encoded hash (algorithm, parameters, salt, digest). */
  hash(secret: string): Promise<string>;
  /** Constant-time comparison; `false` for a malformed encoding. */
  verify(secret: string, encoded: string): Promise<boolean>;
}
