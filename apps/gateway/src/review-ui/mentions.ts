type Candidate = { username: string; displayName: string };
export function attachMentions(root: ShadowRoot | HTMLElement, readCandidates: (prefix: string) => Promise<{ candidates: Candidate[] }>, signal: AbortSignal): void {
  let sequence = 0, start = 0, end = 0, selected = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: HTMLTextAreaElement | undefined;
  const popup = document.createElement("div");
  popup.className = "mention-options";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "Mention suggestions · Participants in this revision only");
  popup.title = "Only the project owner and people who have already commented in this revision are listed.";
  popup.hidden = true;
  const dismiss = () => { sequence++; clearTimeout(timer); popup.hidden = true; popup.replaceChildren(); };
  const pick = (username: string) => {
    if (!target?.isConnected) return dismiss();
    target.setRangeText("@" + username + " ", start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.focus(); dismiss();
  };
  root.addEventListener("input", event => {
    if (!(event.target instanceof HTMLTextAreaElement) || (event as InputEvent).isComposing) return;
    target = event.target; dismiss();
    const match = /(?:^|\s)@([a-z0-9._-]{0,63})$/.exec(target.value.slice(0, target.selectionStart));
    if (!match) return;
    const prefix = match[1]!;
    start = target.selectionStart - prefix.length - 1; end = target.selectionStart;
    const current = sequence;
    timer = setTimeout(async () => {
      try {
        const result = await readCandidates(prefix);
        if (signal.aborted || current !== sequence || !target?.isConnected) return;
        popup.replaceChildren(); selected = 0;
        for (const item of result.candidates) {
          const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "option");
          button.textContent = item.displayName + " (@" + item.username + ")"; button.onclick = () => pick(item.username);
          button.dataset.username = item.username; popup.append(button);
        }
        popup.firstElementChild?.setAttribute("aria-selected", "true");
        target.after(popup); popup.hidden = !popup.childElementCount;
      } catch { dismiss(); }
    }, 180);
  }, { signal });
  root.addEventListener("keydown", rawEvent => {
    const event = rawEvent as KeyboardEvent;
    if (popup.hidden || event.target !== target || event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + popup.childElementCount) % popup.childElementCount;
      [...popup.children].forEach((item, index) => { item.setAttribute("aria-selected", String(index === selected)); });
    }
    if (event.key === "Enter") {
      event.preventDefault(); const option = popup.children[selected];
      if (option instanceof HTMLButtonElement && option.dataset.username) pick(option.dataset.username);
    }
  }, { signal });
  root.addEventListener("focusout", event => { if (event.target === target && !popup.contains((event as FocusEvent).relatedTarget as Node | null)) dismiss(); }, { signal });
  signal.addEventListener("abort", () => { dismiss(); popup.remove(); }, { once: true });
}
