import "./style.css";
import Script from "next/script";
import { reviewTunnelScriptProps } from "@review-tunnel/next";

export const metadata = { title: "Review Tunnel Next.js Fixture" };

export default function RootLayout({ children }) {
  const scriptProps = reviewTunnelScriptProps();
  return (
    <html lang="ko">
      <body>
        {children}
        {scriptProps === undefined ? null : <Script {...scriptProps} />}
      </body>
    </html>
  );
}
