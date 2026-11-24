/** Pure validation shared by the server-only runtime and the standalone migrator. */
export class DatabaseConfigurationError extends Error {
  constructor(variable: string) {
    super(`${variable} must be an explicit PostgreSQL URL with a host, user, and database name.`);
    this.name = "DatabaseConfigurationError";
  }
}

export function requireDatabaseUrl(value: string | undefined, variable: string): string {
  if (!value || value !== value.trim()) throw new DatabaseConfigurationError(variable);
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname || !parsed.username ||
      !/^\/[^/]+$/.test(parsed.pathname) || parsed.hash
    ) throw new Error("invalid");
    return value;
  } catch {
    // Do not attach the original URL/parser exception as a cause.
    throw new DatabaseConfigurationError(variable);
  }
}

export const runtimeConnectionOptions = {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 1800,
  connection: { application_name: "may-be-gay", search_path: "public" },
  onnotice: () => {},
} as const;
