import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const f of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql']) sqlite.exec(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, '$p$1'));
      let values = {};
      return {
        bind(...args) { values = Object.fromEntries(args.map((v, i) => [`$p${i + 1}`, v])); return this; },
        async first() { return statement.get(values) || null; },
        async all() { return { results: statement.all(values) }; },
        execute() {
          const results = statement.columns().length ? statement.all(values) : (statement.run(values), []);
          const meta = sqlite.prepare('SELECT last_insert_rowid() AS last_row_id, changes() AS changes').get();
          return { results, meta };
        },
        async run() { return this.execute(); },
      };
    },
    async batch(stmts) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = stmts.map((s) => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return { sqlite, DB };
}
