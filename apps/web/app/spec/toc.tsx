"use client";

import { useEffect, useState } from "react";
import type { TocEntry } from "../../lib/spec";

/** The outline, with the section in view marked. */
export function Toc({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState<string>("");
  useEffect(() => {
    const ids = entries.filter((e) => e.depth === 2).map((e) => e.id);
    const targets = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const onScroll = () => {
      const y = window.scrollY + 120;
      let current = targets[0]?.id ?? "";
      for (const el of targets) if (el.offsetTop <= y) current = el.id;
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [entries]);

  return (
    <nav className="toc" aria-label="Contents">
      <p className="label">Contents</p>
      <ol>
        {entries
          .filter((e) => e.depth === 2)
          .map((e) => (
            <li key={e.id}>
              <a href={`#${e.id}`} aria-current={active === e.id ? "location" : undefined}>
                {e.text}
              </a>
            </li>
          ))}
      </ol>
    </nav>
  );
}
