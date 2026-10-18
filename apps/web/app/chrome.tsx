import Link from "next/link";
import { REPO, SPEC } from "./content";

/** Three endpoints, one parent and two children: the tree every scope follows. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="5" height="5" />
      <rect x="3" y="6" width="1" height="8" />
      <rect x="4" y="8" width="5" height="1" />
      <rect x="4" y="13" width="5" height="1" />
      <rect x="10" y="6.5" width="4" height="4" />
      <rect x="10" y="11.5" width="4" height="4" opacity="0.5" />
    </svg>
  );
}

export function Header({ page = "home" }: { page?: "home" | "spec" }) {
  return (
    <header className="head">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="wrap head-in">
        <Link href="/" className="brand" aria-label="SCP, home">
          <Mark />
          <span>SCP</span>
        </Link>
        <nav className="nav" aria-label="Site">
          <Link href={SPEC} aria-current={page === "spec" ? "page" : undefined}>
            spec
          </Link>
          <Link href="/#quickstart">quickstart</Link>
          <a href={REPO}>github</a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap rule foot-in">
        <div className="foot-brand">
          <Link href="/" className="brand" aria-label="SCP, home">
            <Mark />
            <span>SCP</span>
          </Link>
          <p>Swarm Communication Protocol, version 1</p>
        </div>
        <nav className="foot-nav" aria-label="Footer">
          <Link href={SPEC}>Specification</Link>
          <Link href={`${SPEC}#18-conformance`}>Conformance</Link>
          <Link href="/#quickstart">Quickstart</Link>
          <a href={REPO}>GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
