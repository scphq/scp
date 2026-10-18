import type { Metadata } from "next";
import { HERO, SITE_TITLE } from "./content";

export const SHARE_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: `${SITE_TITLE}. ${HERO.title} Agent trees on two machines message each other through a hub.`,
};

/** Open Graph and Twitter card fields for a page, all sharing one image. */
export function shareMetadata(title: string, description: string, path: string): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { type: "website", siteName: "SCP", url: path, title, description, images: [SHARE_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [SHARE_IMAGE] },
  };
}
