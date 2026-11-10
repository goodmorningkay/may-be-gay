<img src="assets/icon.svg" width="64" height="64" alt="">

# may-be.gay

A free, expressive profile-page service, starting with an invite-only beta.

The first implementation milestone includes Next.js, PostgreSQL/Drizzle,
local HTTPS, strict hostname routing, a published-profile renderer and CI.
Accounts and the editor are not open yet. Better Auth is pinned but has no
exposed handler until invitation and account protections are implemented.

To explore the fictional sample without configuring a database:

```sh
npm ci
SITE_DOMAIN=may-be.localhost npm run dev
```

Open `http://may-be.localhost:3000` and follow **Find your look**. The sample
offers six presets, two layouts and three system-font choices; it saves no data.
Plain `localhost` is deliberately outside the application's hostname policy.
Links between the apex and app hosts use HTTPS; use the complete stack below
to exercise those links.

For the complete local HTTPS/database stack, see [development setup](docs/development.md).
Read the [implementation plan](docs/implementation-plan.md),
[implementation and review record](docs/implementation-review.md),
[database invariants](docs/database.md) and
[profile renderer contract](docs/profile-renderer.md).

Created in [T3 Code](https://t3.codes).
