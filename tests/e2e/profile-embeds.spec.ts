import { randomBytes, randomUUID } from "node:crypto";
import { account, app, editorSection, expect, publish, saved, state, test } from "./helpers";

const lastFm = {
  title: "Recently played",
  url: "https://www.last.fm/es/user/Petra1999",
  frame: "https://lastfm-embed.vercel.app/api/currently-playing?user=Petra1999&showTitle=false&bgColor=%23181026&textColor=%23f2eee5&urlColor=%23f2eee5&theme=may-be-gay-181026-f2eee5",
  provider: "Last.fm",
};
const spotify = { title: "Favourite track", url: "https://open.spotify.com/intl-de/track/7GhIk7Il098yCjg4BQjzvb?si=share-id", frame: "https://open.spotify.com/embed/track/7GhIk7Il098yCjg4BQjzvb", provider: "Spotify", loadName: "Load Spotify embed" };
const updatedLastFmFrame = lastFm.frame.replaceAll("181026", "301846");
const lastFmFrameSelector = `iframe[title="${lastFm.title} (${lastFm.provider})"]`;
const spotifyFrameSelector = `iframe[title="${spotify.title} (${spotify.provider})"]`;

test("saves and publishes ordered sandboxed embeds in Stacked and Split layouts", async ({ page, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
  const requests: string[] = [];
  for (const embed of [lastFm, spotify]) {
    const frameMatch = embed === lastFm ? "https://lastfm-embed.vercel.app/api/currently-playing?*" : embed.frame;
    await context.route(frameMatch, async route => {
      expect(await route.request().headerValue("referer")).toBeNull();
      requests.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: `<p>${embed.provider} fixture</p>` });
    });
  }
  const owner = await account(page, `review-embeds-${randomBytes(3).toString("hex")}`);
  const initial = await state(context);
  const links = Array.from({ length: 5 }, (_, index) => ({
    id: randomUUID(), label: `Link ${index + 1}`, url: `https://example.com/page-${index + 1}`, visible: true,
  }));
  const seeded = await context.request.put(`${app}/api/profile`, {
    headers: { origin: app, "x-editor-profile": initial.profileId },
    data: {
      expectedVersion: initial.editVersion,
      document: { ...initial.document, links, theme: { ...initial.document.theme, preset: "midnight", colors: { surface: "#181026", accent: "#333333" } } },
    },
  });
  expect(seeded.status()).toBe(200);
  await page.reload();
  const live = page.frameLocator('iframe[title^="Private local profile preview"]');
  await editorSection(page, "Embeds");
  for (const [index, embed] of [lastFm, spotify].entries()) {
    await page.getByRole("button", { name: "Add embed", exact: true }).click();
    const fields = page.getByRole("group", { name: `Embed ${index + 1}`, exact: true });
    await fields.getByLabel("Title", { exact: true }).fill(embed.title);
    const url = fields.getByLabel("Embed URL");
    await url.fill("https://example.com/unsupported");
    await expect(url).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Publish page", exact: true })).toBeDisabled();
    if (embed === lastFm) {
      await url.fill("https://www.last.fm/es/user/");
      await url.pressSequentially("Petra1999");
    } else {
      await url.fill(embed.url);
    }
    await saved(page);
  }
  await expect(live.frameLocator(lastFmFrameSelector).getByText("Last.fm fixture")).toBeVisible();
  expect(requests).toEqual([lastFm.frame]);
  await page.getByRole("group", { name: "Embed 2", exact: true }).getByRole("button", { name: "Move up" }).click();
  await saved(page);
  expect((await state(context)).document.embeds).toEqual([
    expect.objectContaining({ title: spotify.title, url: spotify.url }),
    expect.objectContaining({ title: lastFm.title, url: lastFm.url }),
  ]);

  await page.goto(`${app}/account`);
  await page.getByRole("link", { name: "Edit profile" }).click();
  await expect(page).toHaveURL(`${app}/editor`);
  await expect(live.getByRole("list", { name: "Profile embeds" }).getByRole("heading")).toHaveText([spotify.title, lastFm.title]);
  await expect(live.frameLocator(lastFmFrameSelector).getByText("Last.fm fixture")).toBeVisible();
  await expect(live.locator(spotifyFrameSelector)).toHaveCount(0);
  const requestsBeforePaletteEdit = requests.length;

  await editorSection(page, "Appearance");
  const surface = page.getByLabel("Pick surface colour", { exact: true });
  for (let update = 0; update < 30; update += 1) {
    await surface.fill(`#3018${update.toString(16).padStart(2, "0")}`);
  }
  await surface.fill("#301846");
  await expect(live.locator(lastFmFrameSelector)).toHaveAttribute("src", updatedLastFmFrame);
  await expect.poll(() => requests.slice(requestsBeforePaletteEdit)).toEqual([updatedLastFmFrame]);
  await saved(page);

  const preview = await context.newPage();
  await preview.goto(`${app}/preview`);
  await expect(preview.frameLocator(lastFmFrameSelector).getByText("Last.fm fixture")).toBeVisible();
  await expect(preview.locator(spotifyFrameSelector)).toHaveCount(0);
  await preview.getByRole("button", { name: `${spotify.loadName}: ${spotify.title}` }).click();
  await expect(preview.frameLocator(spotifyFrameSelector).getByText("Spotify fixture")).toBeVisible();

  await publish(page);
  const publicProfile = await context.newPage();
  await publicProfile.setViewportSize({ width: 1050, height: 850 });
  const publicUrl = `https://${owner.username}.may-be.localhost`;
  await publicProfile.goto(publicUrl);
  const cards = publicProfile.getByRole("list", { name: "Profile embeds" });
  const items = cards.getByRole("listitem");
  const profileHeader = publicProfile.locator("main header");
  const profileCard = profileHeader.locator("..");
  await expect(cards.getByRole("heading")).toHaveText([spotify.title, lastFm.title]);
  await expect(publicProfile.getByRole("navigation", { name: "Profile links" }).getByRole("link")).toHaveCount(links.length);
  const stackedProfile = (await profileCard.boundingBox())!;
  const first = (await items.nth(0).boundingBox())!;
  const second = (await items.nth(1).boundingBox())!;
  expect(first.x).toBe(stackedProfile.x);
  expect(first.width).toBe(stackedProfile.width);
  expect(first.y).toBeGreaterThan(stackedProfile.y + stackedProfile.height);
  expect(second.x).toBe(stackedProfile.x);
  expect(second.width).toBe(stackedProfile.width);
  expect(second.y).toBeGreaterThan(first.y + first.height);
  await expect(publicProfile.frameLocator(lastFmFrameSelector).getByText("Last.fm fixture")).toBeVisible();
  await expect(publicProfile.locator(spotifyFrameSelector)).toHaveCount(0);
  await publicProfile.getByRole("button", { name: `${spotify.loadName}: ${spotify.title}` }).click();

  for (const embed of [spotify, lastFm]) {
    const iframe = publicProfile.locator(`iframe[title="${embed.title} (${embed.provider})"]`);
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    const content = iframe.contentFrame().getByText(`${embed.provider} fixture`);
    await expect(content).toBeVisible();
    expect(await content.evaluate(() => self.origin)).toBe(new URL(embed.frame).origin);
  }
  const lastFmFrame = publicProfile.locator(lastFmFrameSelector);
  await expect(lastFmFrame).toHaveAttribute("src", updatedLastFmFrame);
  await expect(cards.getByRole("link", { name: "Open on Last.fm" })).toHaveCSS("color", "rgb(242, 238, 229)");
  await expect(lastFmFrame).toHaveCSS("background-color", "rgb(48, 24, 70)");
  await expect(lastFmFrame).toHaveCSS("color-scheme", "light");

  await editorSection(page, "Appearance");
  await page.getByLabel("Layout", { exact: true }).selectOption("split");
  await publish(page);
  await publicProfile.reload();
  const left = (await items.nth(0).boundingBox())!;
  const right = (await items.nth(1).boundingBox())!;
  const splitProfile = (await profileCard.boundingBox())!;
  const splitIdentity = (await profileHeader.boundingBox())!;
  expect(splitProfile.height).toBeGreaterThan(splitIdentity.height);
  expect(left.x).toBe(splitProfile.x);
  expect(left.y).toBeGreaterThan(splitProfile.y + splitProfile.height);
  expect(right.x).toBeGreaterThan(left.x + left.width);
  expect(right.y).toBe(left.y);

  await publicProfile.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => items.evaluateAll(([first, second]) => {
    const firstBox = first.getBoundingClientRect();
    const secondBox = second.getBoundingClientRect();
    return secondBox.x === firstBox.x && secondBox.top > firstBox.bottom;
  })).toBe(true);

  await editorSection(page, "Embeds");
  await page.getByRole("group", { name: "Embed 1", exact: true }).getByRole("button", { name: "Remove embed" }).click();
  await saved(page);
  await publicProfile.reload();
  await expect(cards.getByRole("heading")).toHaveText([spotify.title, lastFm.title]);
  await publish(page);
  await publicProfile.reload();
  await expect(cards.getByRole("heading")).toHaveText([lastFm.title]);
});
