# Profile model and public renderer

The profile workstream provides a validated versioned document, owned draft/publication services, a private preview and the public renderer. See [the editor/backend contract](profiles-editor.md) for API shapes, transactions, recovery conditions and integration requirements.

## Document v1

`src/domain/profile.ts` exports `profileDocumentSchema` (Zod), its inferred `ProfileDocument` type, `getPublicDocument`, `defaultProfileDocument`, and `createExampleProfile`.

The original fields listed below remain required. Additive v1 fields described below are optional so old stored snapshots parse without modification and retain their appearance. Empty strings are allowed where the minimum is zero; there are no implicit defaults during parsing. All objects are strict: unknown fields at document, theme or link level fail validation rather than being stripped. Strings are preserved, with no trimming, coercion or truncation. Zod's string lengths use JavaScript UTF-16 code units.

| Field | Constraint |
| --- | --- |
| `schemaVersion` | Literal number `1`; other versions fail and need an explicit future migration. |
| `displayName` | String, 1–80. |
| `pronouns` | String, 0–50. |
| `bio` | String, 0–500. |
| `links` | Ordered array, 0–30 entries. |
| `links[].id` | UUID string, unique across all links, including hidden links. UUID case does not bypass uniqueness; original spelling is preserved. |
| `links[].label` | String, 1–100. |
| `links[].url` | Complete HTTP/HTTPS navigation URL, at most 2,048 UTF-16 code units, subject to the rules below. |
| `links[].visible` | Boolean. |
| `theme.preset` | `paper`, `midnight`, `blush`, `forest`, `sunset`, `ocean`. |
| `theme.layout` | `stack` or `split`. |
| `theme.font` | `sans`, `serif` or `mono`, using installed system fonts only. |
| `pageTitle` | String, 0–100. |
| `pageDescription` | String, 0–200. |
| `allowIndexing` | Boolean; false in defaults and demo. This is metadata intent, not access control. |

Links must begin with `http://` or `https://` (case-insensitive), have a valid URL hostname, and contain no credentials, raw whitespace, C0/C1 controls, DEL or backslashes. Even empty userinfo (`https://@example.com`) is rejected. Relative URLs and other schemes are rejected. Percent-encoded path/query text is allowed; validation does not decode and rewrite authored destinations. Parsed URLs are used only for validation and visible destination-host text. Nothing resolves, fetches, previews or proxies the destination server-side. This is navigation validation, not a claim that a destination is trustworthy.

`getPublicDocument(value: unknown)` first parses the **entire** stored document, including hidden entries, then returns a fresh validated document with those entries removed. The result has no hidden labels, identifiers or destinations. It preserves visible link order and does not mutate the stored value. Invalid data throws a Zod error; route-level error handling must not echo that error's data publicly.

Always use this projection before JSON/RSC serialization or passing data into client components. Filtering in the renderer cannot protect a separate serialization of the original stored document. Publication state, ownership, revision selection and cache isolation belong to the server integration.

`defaultProfileDocument` is a complete valid starting value with no links and indexing disabled. Treat the exported object as a template and clone/parse it before editing. `createExampleProfile()` returns a fresh **fictional** Alex Example profile with reserved example-domain links and explicit demo wording. A caller supplying a preview username must label it as an example, never present it as a registered account.

## Renderer usage

```tsx
import { ProfileView } from "@/components/profile-view";
import { createExampleProfile, getPublicDocument } from "@/domain/profile";

// Demonstration only; a public route must select an actual published revision.
const document = getPublicDocument(createExampleProfile());

<ProfileView
  document={document}
  username="example"
  siteDomain="may-be.gay"
/>;
```

`ProfileView({ document, username, siteDomain, media? })` renders a `main` landmark, so do not nest it inside another `main`. It has no client directive, hooks, event handlers, auth/session imports or database access. Its optional music child is a small client component with native controls as a no-JavaScript fallback. Its adjacent CSS module contains all appearance rules. It validates again before rendering, including when TypeScript has been bypassed.

The caller must supply its validated apex domain, not a request Host header or a user-controlled URL. `siteDomain` is a bare hostname (optionally with a non-default development port); it must not include a scheme, path, credentials, query or fragment. Platform anchors use `https://<siteDomain>` and `https://<siteDomain>/support`. The renderer adds a defensive origin-shape check; it does not replace the server's allowed-host policy. Username and domain appear as escaped text; the renderer does not manufacture a profile URL from the username.

All profile text is React text content, including HTML-looking input. Owned media URLs come only from the server resolver map. Controlled custom colors and gradients produce validated inline CSS custom properties. Legacy documents produce no inline styles. Outbound profile links are ordinary same-tab anchors in document order with the destination host visible. They continue to work with JavaScript disabled. Platform attribution and a visible “Report this page or get support” link remain available even for an empty profile. The apex report form is implemented. Operator contact and approved policy remain explicit launch configuration.

Profiles support up to six embeds under the profile card. Last.fm profile URLs resolve to the Snoozeds now-playing widget, which loads automatically near the viewport and uses the profile’s surface and text colours. If the text falls below 4.5:1 contrast against the surface, the widget and its outbound link use whichever of black or white gives higher contrast. Spotify track, album and playlist URLs resolve to the Spotify player and load on request. Both providers use sandboxed, no-referrer frames with fixed endpoints. Each embed also links to the original content. The application validates URLs when saving and rendering and constructs each frame URL from the supported resource identifier.

The frame policy only permits the configured third-party endpoints. Spotify and Snoozeds keep their own origins for playback and polling respectively. Both frames restrict top-level navigation, pop-ups and forms.

## Appearance and accessibility

| Preset | Direction |
| --- | --- |
| `paper` | Warm paper, dark neutral ink, restrained green accent, small corners. |
| `midnight` | Dark navy, pale ink and blue accents, medium corners, dark native controls. |
| `blush` | Soft rose, plum ink, generous rounded corners. |
| `forest` | Sage and off-white, deep green ink, crisp corners. |
| `sunset` | Apricot, warm brown ink, rust accent, softened corners. |
| `ocean` | Cool blue, slate ink, blue accent, pill-like link corners. |

The stacked layout centres identity above a bounded link column. The split layout puts identity and links side by side from 48rem viewport width, collapsing to the same single-column reading order below that. All three font choices work with every preset and layout. Long names, bios and link labels wrap; authored line breaks are retained. There are no external fonts. Optional owned images are resolved from the media map, never an authored URL.

Semantic landmarks, an `h1`, labelled link navigation and a list provide structure. Native anchors supply keyboard activation and focus order. Profile links have large hit areas, footer anchors are at least 44px tall, and keyboard focus has an offset 3px outline. Reduced-motion preferences remove the small hover translation and transitions; forced-colour mode retains link boundaries and focus. Tests calculate at least 4.5:1 contrast for all foreground text colours against both preset surfaces and at least 3:1 for boundaries/focus. These checks are a baseline, not a substitute for later browser and assistive-technology acceptance testing.

## Verification and integration

Run `npm test -- tests/profile`. Tests use `react-dom/server`, with no browser harness or network requests. They cover document/URL/theme limits, strict unknown-key handling, link counts and UUID uniqueness, public projection, escaping, anchor semantics, all 36 preset/layout/font combinations, palette contrast, focus styling and reduced motion.

The current route integration selects published revisions, projects public data before serialization, applies `pageTitle`/`pageDescription` and robots metadata, and supplies a trusted apex domain. It provides the apex `/support` report form with an accurate pending-policy explanation. Dynamic HTML and framework responses use no-store; there is no shared page cache. Any future cache must include the profile identity and published revision. Chromium, Firefox, WebKit, mobile, keyboard and reduced-motion checks are recorded in [browser-acceptance.md](browser-acceptance.md); they do not claim complete assistive-technology or visual coverage.

## Compatible v1 extensions

Optional fields are preserved only when supplied; parsing adds no new defaults to
legacy snapshots. Old revision read/restore uses the same schema and appearance.
All objects remain strict; there is no arbitrary CSS/JS/HTML or remote-URL field.

| Field | Constraint / absent behavior |
| --- | --- |
| `contact` | `{ email }`, null or absent. Explicit public email, max 254, validated without URI header/control injection. Never copied from account login email. |
| `avatarAssetId`, `backgroundAssetId` | UUID, null or absent. Owned ready images, validated again server-side. |
| `music` | `{ assetId: UUID, attribution: string }`, null or absent. Nonblank attribution, max 300; ready owned MP3 required. |
| `links[].icon` | Optional `website`, `github`, `instagram`, `mastodon`, `bluesky`, `twitter`, `x`, `youtube`, `twitch`, `discord`, `linkedin`, `spotify`. Fixed decorative inline SVG beside the visible link label/host. When set to `discord`, `links[].url` stores a nonblank Discord username (1–100 chars, no control characters) instead of a URL and renders a copy-to-clipboard button. |
| `theme.colors` | Optional strict object with optional `background`, `surface`, `ink`, `accent`, each `#rrggbb`. Custom ink also supplies muted text color, and custom accent also supplies border color. |
| `theme.button` | `preset`, `square`, `rounded`, `pill`; absent retains preset corners. |
| `theme.background` | `{ kind: "solid", color }` or `{ kind: "gradient", from, to, direction: "down" \| "right" \| "diagonal" }`. Colors are six-digit hex. |
| `theme.overlay` | `none`, `light`, `dark`; only applied over an owned background image. |
| `theme.spacing` | `compact`, `comfortable`, `airy`; absent/comfortable retains old spacing. |

Custom solid/background choices override the palette background. A supplied
owned image covers that background; the chosen overlay sits above the image.
Content remains above both. Missing or unresolved media is omitted rather than
falling back to an authored URL. Avatar/background accept only validated raster
content types; the track accepts only audio/mpeg. Resolver URLs are checked for
safe navigation syntax or the exact same-origin private-content route shape.
The map is a server-owned trust boundary, not an editor-authored object.

The renderer keeps semantic native link navigation independent of music and
JavaScript. The music child uses `preload="none"`, has no autoplay or mount-time
playback, shows native play/pause controls, adds a hydrated Play/Pause button and
volume slider, and displays rights attribution as escaped text. Keyboard focus
covers buttons and sliders. Forced colors suppress background images/overlays;
increased contrast makes text and borders stronger. Reduced-motion behavior is
retained; there are no new animation effects.

Additional domain exports for the editor are `getProfileAssetIds(document)`
(deduplicated lowercase UUIDs), `hexColorSchema`, `profilePalettes`,
`relativeLuminance`, `contrastRatio`, `getThemeColors(theme)` and
`getThemeContrast(theme)`. Contrast feedback returns minimum `text`, `boundaries`
and `readable` (text >= 4.5) across preset/custom surfaces and gradient endpoints.
Feedback is advisory: gradient interiors, image pixels and overlays require
visual evaluation; an image cannot have a universal contrast guarantee.

The renderer tests now also exercise compatible extensions, controlled style
output, safe contact/icons, resolver media restrictions, no-JavaScript links,
native audio controls, volume, attribution and user-initiated playback structure.
Full private preview and publication acceptance depends on account/media modules
and the parent integration described in [profiles-editor.md](profiles-editor.md).
