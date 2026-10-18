import Link from "next/link";
import { REPO, SPEC } from "./content";

/** Two corner brackets around a solid square. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z" />
      <rect x="11" y="11" width="10" height="10" />
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
