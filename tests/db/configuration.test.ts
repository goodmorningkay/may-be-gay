import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getAuthTables } from "better-auth/db";
import { twoFactor } from "better-auth/plugins";
import { DatabaseConfigurationError, requireDatabaseUrl, runtimeConnectionOptions } from "@/server/db/connection-options";
import { getDatabase } from "@/server/db";
import { getPublishedProfile } from "@/server/profiles";
import { account, session, twoFactor as twoFactorTable, user, verification } from "@/server/db/schema";

afterEach(() => { vi.unstubAllEnvs(); });

describe("database boundaries", () => {
  it("requires an explicit URL and does not include credentials in configuration errors", () => {
    const invalid = [undefined, "", "postgresql:///missing-host", "https://user:secret@db.example/name", "postgresql://user:secret@db.example/", "postgresql://db.example/name", "postgresql://user:secret@db.example/name#secret"];
    for (const value of invalid) {
      try {
        requireDatabaseUrl(value, "DATABASE_URL");
        expect.fail("Expected invalid configuration to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigurationError);
        expect(String(error)).toContain("DATABASE_URL");
        expect(String(error)).not.toContain("secret");
        expect(error).not.toHaveProperty("cause");
      }
    }
    const explicit = "postgresql://app:secret@localhost:5432/may_be_gay";
    expect(requireDatabaseUrl(explicit, "DATABASE_URL")).toBe(explicit);
    expect(runtimeConnectionOptions.max).toBe(5);
  });

  it("imports lazily but fails clearly when the runtime database is requested without configuration", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => getDatabase()).toThrow("DATABASE_URL must be an explicit PostgreSQL URL");
  });

  it("allows only the documented development path to treat an unconfigured database as empty", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(await getPublishedProfile("some-profile")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    await expect(getPublishedProfile("some-profile")).rejects.toBeInstanceOf(DatabaseConfigurationError);
  });

  it("matches core and two-factor field contracts from the installed Better Auth version", () => {
    const authTables = getAuthTables({ plugins: [twoFactor()] });
    const drizzleTables = { user, session, account, verification, twoFactor: twoFactorTable };
    for (const [model, table] of Object.entries(drizzleTables)) {
      const columns = getTableColumns(table);
      expect(columns).toHaveProperty("id");
      for (const field of Object.keys(authTables[model].fields)) expect(columns).toHaveProperty(field);
    }
  });
});
