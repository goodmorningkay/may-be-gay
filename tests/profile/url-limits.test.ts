import { expect, it } from "vitest";
import { createExampleProfile, profileDocumentSchema } from "@/domain/profile";

it("bounds destinations before parsing or publishing them", () => {
  const profile = createExampleProfile();
  profile.links[0].url = "https://example.com/" + "a".repeat(2048);
  expect(profileDocumentSchema.safeParse(profile).success).toBe(false);
});
