<img src="assets/icon.svg" width="64" height="64" alt="">

# may-be.gay

A free, expressive profile-page service, starting with an invite-only beta.

The local application includes invite-gated accounts, a complete profile editor,
six presets, private media processing, publication history, reporting and
administration, account export/deletion, durable workers and encrypted recovery.
Local acceptance and independent review are tracked in the implementation record.
The service has not been launched; live providers and operator policy still need
launch configuration.

To explore the fictional sample without configuring a database:

```sh
npm ci
SITE_DOMAIN=may-be.localhost npm run dev
```

Open `http://may-be.localhost:3000` and select the profile preview. The sample
offers six presets, two layouts and three system-font choices; it saves no data.
Plain `localhost` is deliberately outside the application's hostname policy.
Links between the apex and app hosts use HTTPS; use the complete stack below
to exercise those links.

For the complete local HTTPS/database stack, see [development setup](docs/development.md).
Read the [implementation plan](docs/implementation-plan.md),
[current implementation and review record](docs/non-launch-review.md),
[database invariants](docs/database.md) and
[profile renderer contract](docs/profile-renderer.md).
Account setup is documented in [accounts](docs/accounts.md), worker operation in
[worker](docs/worker.md), and isolated cross-browser acceptance in
[browser acceptance](docs/browser-acceptance.md).

Created in [T3 Code](https://t3.codes).
