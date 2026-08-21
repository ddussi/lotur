import Link from "next/link";
import { Suspense } from "react";
import InteractiveFixture from "./interactive-fixture";

async function StreamedMarker() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return <p data-testid="rsc-stream">next-rsc-stream-ready</p>;
}

export default function Home() {
  return (
    <main>
      <h1>Next.js through Review Tunnel</h1>
      <InteractiveFixture />
      <Suspense fallback={<p data-testid="rsc-fallback">streaming…</p>}>
        <StreamedMarker />
      </Suspense>
      <Link href="/details" data-testid="details-link">client navigation</Link>
    </main>
  );
}
