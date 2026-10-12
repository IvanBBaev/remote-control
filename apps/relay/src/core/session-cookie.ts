/** `__Host-`: Secure, `Path=/`, no `Domain` — the browser pins it to this exact origin. */
const NAME = '__Host-rc_session';
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';

/** The login session cookie (D8, 02 §5.5). Its value is the token; the relay stores only its hash. */
export const sessionCookie = {
  name: NAME,

  serialize(token: string, maxAgeSec: number): string {
    return `${NAME}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; ${ATTRIBUTES}`;
  },

  /** Expires the cookie in the browser (logout, rejected session). */
  clear(): string {
    return `${NAME}=; Max-Age=0; ${ATTRIBUTES}`;
  },

  /** The token from a `Cookie` request header, or `undefined`. */
  read(header: string | undefined): string | undefined {
    if (header === undefined) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0 && part.slice(0, separator).trim() === NAME) {
        const value = part.slice(separator + 1).trim();
        return value === '' ? undefined : value;
      }
    }
    return undefined;
  },
};
