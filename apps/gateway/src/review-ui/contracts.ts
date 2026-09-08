import type { ReviewPageInfo, ReviewService } from "../../../../packages/review/src/index.ts";
import type { PublicComment, PublicReply, PublicNotification } from "../review-contract.ts";
export type { PublicComment, PublicReply, PublicNotification };
export type ReviewContext = Awaited<ReturnType<ReviewService["getContext"]>> & { controlOrigin?: string };
export type CommentPage = {
  comments: PublicComment[];
  openCount: number;
  eventCursor: string;
  pageInfo: ReviewPageInfo;
};
export type ReplyPage = { replies: PublicReply[]; pageInfo: ReviewPageInfo };
