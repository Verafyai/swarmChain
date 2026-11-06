# Verafy Chain site

The Verafy Chain concept page, served at https://chain.verafy.ai. One static page, no build step.

- `index.html` is the page. `logo.svg` is the favicon, `banner.png` the share image.
- `vercel.json` sends the old harness paths (`/run`, `/testnet`, `/coin-agnostic`) to https://harness.verafy.ai, and sends every request on the old host swarmchain.verafy.ai to the same path on chain.verafy.ai.
- The harness pages live in [Verafyai/verafyHarness](https://github.com/Verafyai/verafyHarness) under `site/`, served at https://harness.verafy.ai.
