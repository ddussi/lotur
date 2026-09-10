import type { ReviewContext } from "./contracts.ts";

export function reviewRevisionLabel(context: ReviewContext): string {
  const state = context.workingTree?.state ?? "unknown";
  const changes = state === "modified" ? "추가 수정 있음" : state === "clean" ? "추가 수정 없음" : "추가 수정 여부 미확인";
  return `프로젝트: ${context.project.displayName}\n기준 버전: ${context.revision.key}\n${changes}${state !== "unknown" ? " · 공유 시작 시 개발자 입력" : ""}\n실시간 개발 화면이므로 이후 내용은 바뀔 수 있습니다.`;
}
