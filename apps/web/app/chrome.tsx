import Link from "next/link";
import { DEMO, DOCS, REPO, SPEC } from "./content";

/** Two corner brackets around a solid square. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z" />
      <rect x="11" y="11" width="10" height="10" />
    </svg>
  );
}

export function Header({ page = "home" }: { page?: "home" | "docs" | "spec" }) {
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
          <Link href={DOCS} aria-current={page === "docs" ? "page" : undefined}>
            docs
          </Link>
          <Link href={SPEC} aria-current={page === "spec" ? "page" : undefined}>
            spec
          </Link>
          <Link href="/#quickstart">quickstart</Link>
          <a href={DEMO}>demo</a>
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
          <Link href={SPEC}>Spec</Link>
          <Link href={DOCS}>Docs</Link>
          <Link href={`${DOCS}/self-host`}>Self-host</Link>
          <a href={DEMO}>Dashboard</a>
          <a href={REPO}>GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
