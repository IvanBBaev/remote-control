/**
 * Push services the browsers the PWA supports subscribe to (Chrome/Edge via FCM, Firefox
 * via Mozilla autopush, Safari/iOS via Apple, legacy Edge via WNS). The relay POSTs to
 * whatever endpoint a phone registers, so only these hosts are accepted (no SSRF).
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export const MAX_ENDPOINT_LENGTH = 2048;

/** `true` for an `https:` URL on a known push service, without credentials or port. */
export function isKnownPushService(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH || !URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname))
  );
}
