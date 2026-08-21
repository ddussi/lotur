import "./style.css";

const root = document.querySelector("#app");
root.innerHTML = `
  <h1>Vite through Review Tunnel</h1>
  <p data-testid="hmr-marker">vite-hmr-v1</p>
  <button data-testid="counter" type="button">count: 0</button>
`;

let count = 0;
root.querySelector("[data-testid=counter]").addEventListener("click", (event) => {
  count += 1;
  event.currentTarget.textContent = `count: ${count}`;
});

if (import.meta.hot) import.meta.hot.accept();
