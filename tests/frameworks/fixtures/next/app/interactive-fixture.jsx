"use client";

import { useActionState, useEffect, useState } from "react";
import { echoAction } from "./server-actions";

export default function InteractiveFixture() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [result, action, pending] = useActionState(echoAction, "");
  useEffect(() => setHydrated(true), []);
  return (
    <section>
      <p data-testid="refresh-marker">next-fast-refresh-v1</p>
      <button data-testid="counter" type="button" disabled={!hydrated} onClick={() => setCount((value) => value + 1)}>
        count: {count}
      </button>
      <form action={action}>
        <input name="message" defaultValue="server-action-ok" aria-label="message" />
        <button type="submit" disabled={pending || !hydrated}>run server action</button>
      </form>
      <output data-testid="action-result">{result}</output>
    </section>
  );
}
