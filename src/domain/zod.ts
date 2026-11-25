import { z } from "zod";

// Strict production CSP forbids dynamic code, including Zod's caught Function("") probe.
z.config({ jitless: true });

export { z };
