export async function bindReviewOrClose(input: Readonly<{
  review?: Readonly<{
    projectSlug: string;
    revisionKey: string;
  }>;
  tunnelId: string;
  bindReview(review: Readonly<{
    tunnelId: string;
    projectSlug: string;
    revisionKey: string;
  }>): Promise<void>;
  closeTunnel(): Promise<unknown>;
}>): Promise<void> {
  if (input.review === undefined) return;
  try {
    await input.bindReview({
      tunnelId: input.tunnelId,
      projectSlug: input.review.projectSlug,
      revisionKey: input.review.revisionKey,
    });
  } catch (error) {
    try {
      await input.closeTunnel();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Review binding failed and the active Tunnel could not be closed cleanly",
      );
    }
    throw error;
  }
}
