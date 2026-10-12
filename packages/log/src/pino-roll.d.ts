// pino-roll ships no type declarations; this covers the subset packages/log uses.
declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    mkdir?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }

  interface PinoRollStream extends DestinationStream {
    end(): void;
    once(event: 'close' | 'finish' | 'ready', listener: () => void): this;
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<PinoRollStream>;
}
