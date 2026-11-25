import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proxy Studio — Universal AI Gateway",
  description: "A local-first studio for connecting AI chat websites to OpenAI-compatible clients.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
