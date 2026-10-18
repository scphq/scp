import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Footer } from "./chrome";
import { SITE, SITE_DESCRIPTION, SITE_TITLE } from "./content";
import { shareMetadata } from "./share";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: SITE_TITLE, template: "%s, SCP" },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  ...shareMetadata(SITE_TITLE, SITE_DESCRIPTION, "/"),
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#090909" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <Footer />
      </body>
    </html>
  );
}
