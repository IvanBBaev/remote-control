import type { MediaQuery } from '../ports/media-query.js';

/** The part of `window` a media query needs. */
export interface MatchMediaSource {
  matchMedia(
    query: string,
  ): Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
}

/** `query` through `window.matchMedia`, re-read on every `change`. */
export function browserMediaQuery(source: MatchMediaSource, query: string): MediaQuery {
  const list = source.matchMedia(query);
  return {
    matches: () => list.matches,
    subscribe: (onChange) => {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
  };
}
