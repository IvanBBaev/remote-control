import { revealHidden } from '@remote-control/phone-core/card-safety/hidden-characters';
import type { RevealedText } from '@remote-control/phone-core/card-safety/hidden-characters';

/**
 * A text from the computer as the card shows it (V3-S03): every hidden or
 * direction-changing character is a highlighted `⟨U+XXXX⟩` marker in its place.
 */
export function Revealed({ text }: { readonly text: string | RevealedText }) {
  const revealed = typeof text === 'string' ? revealHidden(text) : text;
  return (
    <>
      {revealed.parts.map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <mark key={index} className="hidden-char" title={`Hidden character (${part.kind})`}>
            {part.text}
          </mark>
        ),
      )}
    </>
  );
}

/** The card's warnings (V3-S03), shown before the content is revealed. */
export function CardWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="card-warnings" role="alert">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}
