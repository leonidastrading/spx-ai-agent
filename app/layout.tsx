import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book Advisor",
  description: "Shadow-mode morning run/reduce/skip advisor for SPX strategies. Never trades.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <span className="brand">Book advisor</span>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/scoring">Scoring</Link>
          <Link href="/upload">Upload P/L</Link>
          <Link href="/settings">Settings</Link>
          <span className="shadow">Shadow mode · never places orders</span>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
