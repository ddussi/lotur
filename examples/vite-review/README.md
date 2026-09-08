# Fieldnotes review example

A small, synthetic launch workspace for trying page comments, responsive pins, and re-review. It uses Vite and the existing `@review-tunnel/vite` development integration, with no external API, images, fonts, or real customer data.

From the repository root, follow the [local demo guide](../../docs/local-demo.en.md) ([한국어](../../docs/local-demo.md)):

```sh
npm ci
npm run demo
```

Use the printed shared URL to see the review overlay. The direct Vite port only serves the example app; it does not provide Gateway review endpoints.

Edit [src/main.js](src/main.js) and [src/style.css](src/style.css) while the demo is running to try live updates. **Try compact layout** changes the layout without replacing the card's stable `data-review-id`, so a pin attached to that card follows it. **Launch brief** demonstrates client-side navigation. Checklist changes are page-local and reset on reload; submitted reviews persist in the demo database.

The example is covered by the repository MIT license. It does not import test fixtures or contain production configuration.
