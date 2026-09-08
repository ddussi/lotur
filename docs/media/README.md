# Local demo media

Captured from the actual authenticated Vite example with synthetic local accounts and data.

- [pinned-review.png](pinned-review.png): a region comment attached to the launch card.
- [needs-review.png](needs-review.png): the pin follows the compact layout; a developer reply requests re-review.
- [review-inbox.png](review-inbox.png): recipient notifications and completed processing history.
- `review-flow.webm`: the same browser flow, captured after login; developer actions happen in a separate unrecorded browser.

Regenerate from the repository root after `npm ci` and `npm run build`, with Chrome, FFmpeg (libvpx/WebM), and local Docker available:

```sh
node tests/demo/capture-media.mjs
```

The capture creates and deletes its own demo database. It replaces only these four named media files and this index. Inspect the resulting images/video before committing; cookie state is kept in memory and never saved. Only the initial loading interval is trimmed. Set REVIEW_TUNNEL_MEDIA_FFMPEG to an explicit FFmpeg executable when it is not on PATH.

The example and these original captures are covered by the repository's [MIT license](../../LICENSE). The recording illustrates product behavior and is not a performance benchmark.
