# Review with a small team

[한국어](internal-review-guide.md) · [Getting started](getting-started.en.md) · [Documentation](documentation.md)

Use the review panel on the shared app together with the inbox at your Gateway's control host, `/reviews`. This guide describes the integrated review behavior in `41e9570`. Developers and reviewers have deployment-wide access; use a Gateway with people who may see each other's projects.

## From feedback to verification

1. Leave a page comment or select a point/region on the shared app. Close the panel when it covers the page and reopen it from the corner button. The mobile panel starts collapsed.
2. Use the open-work and author filters to find unfinished comments or reviews you started. The inbox also lets you choose the revision and page path.
3. After changing the app, a developer replies and chooses **Request review**. The comment becomes **Needs review**, and its original author receives an internal notification. Replies remain available while verification is pending.
4. The original author chooses **Confirm resolved** or **Request more changes**. The requesting developer receives the outcome. A developer can also use **Resolve** directly for a simple task.
5. Open the comment in the inbox to read its processing history. The latest 100 history records are displayed; this history is stored separately from the temporary live-update event feed.

New review requests require the operator to enable the workflow as described below. An inactive author or an author without review access cannot receive a new verification request.

## Pins and filtering

**Hide all pins** clears the markers while preserving the comment list. **Show pin** reveals one comment's marker, and **Pin #…** jumps to its location. **Show all pins** restores the loaded markers. These choices affect your view, not other reviewers or saved feedback.

Give small, meaningful elements a stable, unique `data-review-id` or `id` so new pins can follow them across layout changes. A missing, hidden, or duplicate target hides the marker with an explanation. Coordinate-only pins show an approximate-position label and are hidden when the captured and current layout dimensions differ. See [pin placement and visibility](getting-started.en.md#pin-placement-and-visibility).

Filters query the saved comments on the server, including older comments; they are not limited to the first loaded page. Loading or changing a filter preserves the current tab's drafts.

## Return after the app stops

Copy a comment's **Permanent link** to reopen it in the inbox. If sign-in or an initial password change is required, the browser returns to that comment afterward. Stopping a share leaves saved comments and replies available for reading and permitted edits.

**Open in app** lists active shares for the same project and revision on the current Gateway. It restores the saved page path and selected comment. Query parameters and URL fragments are not collected or restored, and shares known only to another Gateway do not appear.

The operator's global kill switch is different from stopping one share: while the switch is enabled, the inbox is read-only.

## Preserve work within the tab

Live updates, panel collapse, filters, and in-app page navigation preserve drafts in the current tab's memory. If someone edits the same comment first, the editor keeps your input and shows the newer version. Compare the contents, then choose **Use latest version and keep draft** before saving again.

Reloading or closing the tab loses unsaved drafts. Saved comments remain in PostgreSQL. Drafts are not transferred to another browser or device.

## Find notifications

- Type `@` to choose the project owner or people who already participate in this revision. A teammate who has not participated may be absent from the list.
- New replies notify the original author and previous reply participants. The sender is excluded, and a mention plus participation in the same reply produces one notification.
- **My notifications** in the inbox combines projects and page paths, loads 50 records at a time, and offers an unread filter. Successfully opening the linked comment marks that notification read.
- Verification outcomes belong to the corresponding request round. Notifications are visible only to their recipient and stay within Review Tunnel.

## Enable re-review as an operator

1. Run the existing Admin CLI migration procedure. Review migrations 19–21 add workflow state/history and notification support. Repeating migration preserves existing comments.
2. Upgrade every Gateway that reads this database to a version supporting the new state. Readiness rejects an incomplete schema.
3. Set `REVIEW_WORKFLOW_ENABLED=true` to allow new verification requests. The runtime default is false. Disabling new requests still permits reading existing requests/history and responding to a pending request.

Workflow changes use a version separate from the comment body. An older request without `expectedWorkflowVersion` is accepted only at initial workflow version 1; later changes conflict. Reload an outdated page. The context response advertises available features.

This alpha provides neither per-project membership nor external invitations, email/Slack/push delivery, automatic transfer of comments across revisions, or complete edit history. See the [security policy](../SECURITY.md) and [current implementation status](poc-status.md).
