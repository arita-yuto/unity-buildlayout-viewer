import { booleanEnv, resolveEnv, typeEnv } from "@/lib/env/helpers";

import "server-only"

export const env = {
    DATABASE_URL: process.env.DATABASE_URL,
    SNAPSHOT_RETENTION_DAYS: Number(typeEnv<string>(process.env.SNAPSHOT_RETENTION_DAYS, "90")),
} as const;
