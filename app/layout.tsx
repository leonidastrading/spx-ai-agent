import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book Advisor",
  description: "Shadow-mode SPX book advisor, plus paper-only AI day-trader and swing-ideas tests.",
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
          <Link href="/trader">Day trader</Link>
          <Link href="/swing">Swing ideas</Link>
          <Link href="/settings">Settings</Link>
          <span className="shadow">Advisor: shadow mode · Trader &amp; swing: paper only</span>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
