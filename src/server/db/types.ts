import type { getDatabase } from "./index";

export type Database = ReturnType<typeof getDatabase>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
