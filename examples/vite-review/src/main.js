import "./style.css";

const tasks = [
  { label: "Find our story", detail: "A clear idea, in a few good words.", done: true },
  { label: "Refine the experience", detail: "Make the small interactions feel right.", done: true },
  { label: "Gather a second opinion", detail: "Fresh eyes make the work better.", done: false },
  { label: "Give it a final look", detail: "One last pass before the next chapter.", done: false },
];
const view = document.querySelector("#view");

function render() {
  const details = location.pathname === "/details";
  for (const link of document.querySelectorAll(".tabs a")) {
    if (link.getAttribute("href") === location.pathname) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  view.innerHTML = details ? `
    <section class="brief card" data-review-id="launch-brief">
      <span class="eyebrow">LAUNCH BRIEF · V01</span><h2>Useful, thoughtful,<br>and ready for a fresh perspective.</h2>
      <p>We're making a quieter space to plan a launch. Every screen should help people understand what matters and what comes next.</p>
      <div class="brief-grid"><div><h3>What we're looking for</h3><p>Clear language, comfortable spacing, and a friendly path through the checklist.</p></div><div><h3>Where to leave feedback</h3><p>Leave a page comment for the big picture, or pin a detail that could feel a little better.</p></div></div>
      <a class="text-link" href="/" data-route="/">Back to the overview <span aria-hidden="true">↗</span></a>
    </section>` : `
    <div class="workspace-grid">
      <section class="card launch-card" data-review-id="launch-card" aria-labelledby="launch-title">
        <div class="card-top"><span class="eyebrow">PROJECT 001</span><span class="status"><span aria-hidden="true"></span>In progress</span></div>
        <div class="project-art" aria-hidden="true"><div class="art-sun"></div><div class="art-sheet sheet-back"></div><div class="art-sheet sheet-front"><span></span><span></span><span></span><i>Make room<br>for good ideas.</i></div><span class="art-label">A NEW PERSPECTIVE</span></div>
        <div class="card-body"><h2 id="launch-title">The Fieldnotes launch</h2><p>A considered start to something new.</p><div class="project-meta"><span><span class="avatar small" aria-hidden="true">A</span>Ari &amp; the team</span><span>Version 01</span></div></div>
      </section>
      <section class="card checklist" data-review-id="launch-checklist" aria-labelledby="checklist-title">
        <div class="card-top"><h2 id="checklist-title">The final details</h2><span class="count" id="progress-label" aria-live="polite"></span></div>
        <div class="progress-track" aria-hidden="true"><div id="progress-bar"></div></div>
        <div class="tasks">${tasks.map((task, index) => `<label class="task"><input type="checkbox" data-task="${index}" ${task.done ? "checked" : ""}><span class="task-copy"><strong>${task.label}</strong><span>${task.detail}</span></span></label>`).join("")}</div>
        <button id="preview-launch" class="primary-button" data-review-id="launch-button">Preview the launch <span aria-hidden="true">↗</span></button>
        <p class="preview-message" id="preview-message" aria-live="polite">A preview only. Your feedback makes the next version.</p>
      </section>
    </div>
    <aside class="review-note" data-review-id="feedback-note"><span class="note-icon" aria-hidden="true">✳</span><div><h3>Better with another pair of eyes.</h3><p>Try a page comment, pin a detail, or switch the layout to see your feedback stay in place.</p></div><span class="note-arrow" aria-hidden="true">↗</span></aside>`;
  updateProgress();
}
function updateProgress() {
  const complete = tasks.filter(task => task.done).length;
  const label = document.querySelector("#progress-label");
  if (label) label.textContent = `${complete} of ${tasks.length}`;
  const progress = document.querySelector("#progress-bar");
  if (progress) progress.style.width = `${complete / tasks.length * 100}%`;
}

document.addEventListener("click", event => {
  const link = event.target.closest("[data-route]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    history.pushState({}, "", link.dataset.route);
    render();
  }
  if (event.target.closest("#preview-launch")) {
    document.querySelector("#preview-message").textContent = "Looking good. This is a local preview — nothing was published.";
  }
});
document.addEventListener("change", event => {
  if (event.target.matches("[data-task]")) {
    tasks[Number(event.target.dataset.task)].done = event.target.checked;
    updateProgress();
  }
});
document.querySelector("#layout-toggle").addEventListener("click", event => {
  const compact = document.querySelector("main").classList.toggle("compact");
  event.currentTarget.setAttribute("aria-pressed", String(compact));
});
window.addEventListener("popstate", render);
render();
