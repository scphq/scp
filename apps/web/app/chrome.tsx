import Link from "next/link";
import { DEMO, DOCS, REPO, SPEC } from "./content";

/** Two canted shoulders around a free square. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M4 12L28 5Q42 1 48 16H24L16 24V40Q4 37 4 24Z" />
      <path d="M24 24H40V40H24Z" />
      <path d="M60 52L36 59Q22 63 16 48H40L48 40V24Q60 27 60 40Z" />
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
          <a href="/llms.txt">llms.txt</a>
        </nav>
      </div>
    </footer>
  );
}
