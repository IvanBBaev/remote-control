/** The real clock; everything else takes `now` as an argument (ROADMAP §5). */
export function systemNow(): number {
  return Date.now();
}
