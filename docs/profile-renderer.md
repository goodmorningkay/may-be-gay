# Profile model and public renderer

This milestone provides a validated profile document and a read-only React renderer. It is a foundation for later publishing and editing work. It does not create accounts, claim usernames, save drafts or publish profiles.

## Document v1

`src/domain/profile.ts` exports `profileDocumentSchema` (Zod), its inferred `ProfileDocument` type, `getPublicDocument`, `defaultProfileDocument`, and `createExampleProfile`.

Every field is required. Empty strings are allowed where the minimum is zero; there are no implicit defaults during parsing. All objects are strict: unknown fields at document, theme or link level fail validation rather than being stripped. Strings are preserved, with no trimming, coercion or truncation. Zod's string lengths use JavaScript UTF-16 code units.

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

`ProfileView({ document, username, siteDomain })` renders a `main` landmark, so do not nest it inside another `main`. It has no client directive, hooks, event handlers, auth/session imports or database access. Its adjacent CSS module contains all appearance rules. It validates again before rendering, including when TypeScript has been bypassed.

The caller must supply its validated apex domain, not a request Host header or a user-controlled URL. `siteDomain` is a bare hostname (optionally with a non-default development port); it must not include a scheme, path, credentials, query or fragment. Platform anchors use `https://<siteDomain>` and `https://<siteDomain>/support`. The renderer adds a defensive origin-shape check; it does not replace the server's allowed-host policy. Username and domain appear as escaped text; the renderer does not manufacture a profile URL from the username.

All profile text is React text content, including HTML-looking input. There is no authored HTML, CSS, JavaScript, inline style, embed, remote image, tracking redirect or media player. Outbound links are ordinary same-tab anchors, in document order, with the destination host visible. They continue to work with JavaScript disabled. Platform attribution and a visible “Report this page or get support” link remain available even for an empty profile. This foundation explicitly states that support/reporting policy is pending configuration; it does not claim an operational report form exists.

## Appearance and accessibility

| Preset | Direction |
| --- | --- |
| `paper` | Warm paper, dark neutral ink, restrained green accent, small corners. |
| `midnight` | Dark navy, pale ink and blue accents, medium corners, dark native controls. |
| `blush` | Soft rose, plum ink, generous rounded corners. |
| `forest` | Sage and off-white, deep green ink, crisp corners. |
| `sunset` | Apricot, warm brown ink, rust accent, softened corners. |
| `ocean` | Cool blue, slate ink, blue accent, pill-like link corners. |

The stacked layout centres identity above a bounded link column. The split layout puts identity and links side by side from 48rem viewport width, collapsing to the same single-column reading order below that. All three font choices work with every preset and layout. Long names, bios and link labels wrap; authored line breaks are retained. There are no external fonts or image assets.

Semantic landmarks, an `h1`, labelled link navigation and a list provide structure. Native anchors supply keyboard activation and focus order. Profile links have large hit areas, footer anchors are at least 44px tall, and keyboard focus has an offset 3px outline. Reduced-motion preferences remove the small hover translation and transitions; forced-colour mode retains link boundaries and focus. Tests calculate at least 4.5:1 contrast for all foreground text colours against both preset surfaces and at least 3:1 for boundaries/focus. These checks are a baseline, not a substitute for later browser and assistive-technology acceptance testing.

## Verification and integration still required

Run `npm test -- tests/profile`. Tests use `react-dom/server`, with no browser harness or network requests. They cover document/URL/theme limits, strict unknown-key handling, link counts and UUID uniqueness, public projection, escaping, anchor semantics, all 36 preset/layout/font combinations, palette contrast, focus styling and reduced motion.

The current route integration selects published revisions, projects public data before serialization, applies `pageTitle`/`pageDescription` and robots metadata, and supplies a trusted apex domain. It provides the apex `/support` route with an accurate pending-policy explanation. Dynamic HTML and framework responses use no-store; there is no shared page cache. Any future cache must include the profile identity and published revision. Browser checks for narrow screens, zoom, keyboard focus, reduced motion and the planned Chromium/Firefox/WebKit acceptance remain later work.

The following planned features are deliberately unimplemented: custom colours, button variants, background/gradient/overlay controls, adjustable spacing, uploaded avatars/backgrounds, social icon configuration, animation controls, all music/media, editing, autosave, revision history and publish/unpublish controls. None has a schema escape hatch or an interactive placeholder. Later additions require an explicit validated contract (and a version migration where necessary), rather than arbitrary HTML/CSS/JS or remote assets.
