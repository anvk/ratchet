// Must be imported before the engine, which connects using DATABASE_URL.
// Tests get their own database, so they don't fill up the dashboard and a
// running `pnpm dev` can't steal their work.

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

export const TEST_DATABASE = "ratchet_test";
export const adminUrl = process.env.DATABASE_URL;

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${TEST_DATABASE}`;
export const testDatabaseUrl = testUrl.href;

process.env.DATABASE_URL = testDatabaseUrl;
