import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * A throwaway copy of a migrations folder for tests that add or edit migrations
 * without touching the committed `drizzle/` folder.
 */
export class MigrationsFixture {
  readonly folder: string;

  constructor(source: string) {
    this.folder = mkdtempSync(join(tmpdir(), 'rc-migrations-'));
    cpSync(source, this.folder, { recursive: true });
  }

  private journal(): Journal {
    return JSON.parse(readFileSync(this.journalPath(), 'utf8')) as Journal;
  }

  private journalPath(): string {
    return join(this.folder, 'meta', '_journal.json');
  }

  /** Appends a migration with the given SQL and journal timestamp. */
  add(tag: string, when: number, sql: string): void {
    const journal = this.journal();
    journal.entries.push({
      idx: journal.entries.length,
      version: '7',
      when,
      tag,
      breakpoints: true,
    });
    writeFileSync(this.journalPath(), JSON.stringify(journal));
    writeFileSync(join(this.folder, `${tag}.sql`), sql);
  }

  /** Rewrites the SQL of an existing migration (changes its hash). */
  edit(tag: string, sql: string): void {
    writeFileSync(join(this.folder, `${tag}.sql`), sql);
  }

  /** Journal timestamp of the newest migration. */
  newestWhen(): number {
    return Math.max(...this.journal().entries.map((entry) => entry.when));
  }

  remove(): void {
    rmSync(this.folder, { recursive: true, force: true });
  }
}
