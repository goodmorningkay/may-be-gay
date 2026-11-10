import { z } from "zod";

// Configure before client schemas with eagerly parsed defaults are imported.
// Strict production CSP forbids dynamic code, including Zod's caught probe.
z.config({ jitless: true });
