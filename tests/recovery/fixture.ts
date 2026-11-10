import postgres from "postgres";
import { bootstrapTestDatabase } from "../db/harness";
export async function fixture(url: string) {
  if (!/^\/[a-z0-9_]+_test$/.test(new URL(url).pathname)) throw new Error("DISPOSABLE_DATABASE_REQUIRED");
  const setup = postgres(url, { onnotice: () => {} });
  try {
    await setup`do $$ begin if not exists(select from pg_roles where rolname='may_be_app') then create role may_be_app nologin; end if; end $$`;
  } finally { await setup.end(); }
  const h = await bootstrapTestDatabase(url);
  return h;
}
