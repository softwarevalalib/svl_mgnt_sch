import Database from 'better-sqlite3';
import path from 'path';
import { schemaV2Consolidated } from './schema-v2-consolidated';
import { homeworkAssignmentsSchema } from './schema-homework-assignments';
import { syncSchema } from './schema-sync';
import { gradebookLessonPermsSchema } from './schema-gradebook-lesson-perms';

let db: Database.Database;

export function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/svl-sms.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateInstitutionBranding(database?: Database.Database): void {
  const target = database || getDatabase();
  ensureColumn(target, 'institutions', 'primary_color', "TEXT DEFAULT '#1e40af'");
  ensureColumn(target, 'institutions', 'secondary_color', "TEXT DEFAULT '#3b82f6'");
  ensureColumn(target, 'institutions', 'accent_color', "TEXT DEFAULT '#f59e0b'");
}

export function initializeDatabase(): void {
  const database = getDatabase();

  database.exec(schemaV2Consolidated);
  database.exec(homeworkAssignmentsSchema);
  database.exec(syncSchema);
  database.exec(gradebookLessonPermsSchema);
  migrateInstitutionBranding(database);
  backfillUserRoles(database);

  console.log('✓ Multi-tenant database initialized successfully');
  console.log('✓ Database schema with homework/assignments system created');
  console.log('✓ Gradebook, lesson plans, multi-role, password-request tables ready');
}

/** Ensure existing users with role_id appear in user_roles for multi-role merge. */
function backfillUserRoles(database: Database.Database): void {
  database.prepare(`
    INSERT OR IGNORE INTO user_roles (user_id, role_id, is_primary)
    SELECT id, role_id, 1 FROM users WHERE role_id IS NOT NULL
  `).run();
}
