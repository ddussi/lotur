export const REVIEW_MENTIONS_VIEW_SOURCE = `(root, readCandidates) => {
  let sequence = 0, timer, target, start, end, selected = 0;
  const popup = document.createElement("div"); popup.className = "mention-options"; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Mention suggestions · Participants in this revision only"); popup.title = "Only the project owner and people who have already commented in this revision are listed."; popup.hidden = true;
  const dismiss = () => { sequence++; popup.hidden = true; popup.replaceChildren(); };
  const pick = username => {
    if (!target?.isConnected) return dismiss();
    target.setRangeText("@" + username + " ", start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.focus(); dismiss();
  };
  root.addEventListener("input", event => {
    if (event.target.tagName !== "TEXTAREA" || event.isComposing) return;
    target = event.target; clearTimeout(timer); dismiss();
    const prefixText = target.value.slice(0, target.selectionStart);
    const match = /(?:^|\\s)@([a-z0-9._-]{0,63})$/.exec(prefixText);
    if (!match) return;
    start = target.selectionStart - match[1].length - 1; end = target.selectionStart;
    const current = sequence;
    timer = setTimeout(async () => {
      try {
        const result = await readCandidates(match[1]);
        if (current !== sequence || !target.isConnected) return;
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
  });
  root.addEventListener("keydown", event => {
    if (popup.hidden || event.target !== target || event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + popup.childElementCount) % popup.childElementCount;
      [...popup.children].forEach((item, index) => item.setAttribute("aria-selected", String(index === selected)));
    }
    if (event.key === "Enter") { event.preventDefault(); pick(popup.children[selected].dataset.username); }
  });
  root.addEventListener("focusout", event => { if (event.target === target && !popup.contains(event.relatedTarget)) dismiss(); });
}`;
