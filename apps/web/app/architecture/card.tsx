import Link from "next/link";
import "./architecture.css";

/** harnesses, a broker per machine and the org hub, as a thumbnail of /architecture */
function Thumbnail() {
  const harness = [14, 34, 54, 74];
  return (
    <svg viewBox="0 0 240 104" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" focusable="false">
      <g opacity="0.55">
        {harness.map((y) => (
          <rect key={y} x="4" y={y} width="44" height="14" />
        ))}
      </g>
      <path d="M48 21h18M48 41h18M48 61h18M48 81h18M66 21v60M66 51h14" opacity="0.4" />
      <rect x="80" y="36" width="56" height="30" />
      <path d="M136 51h32" stroke="var(--acc)" strokeWidth="1.5" />
      <rect x="168" y="22" width="68" height="58" stroke="var(--acc)" />
      <rect x="176" y="32" width="52" height="12" opacity="0.5" />
      <rect x="176" y="58" width="52" height="12" opacity="0.5" />
      <g fill="currentColor" stroke="none">
        <rect x="104" y="47" width="8" height="8" />
        <rect x="198" y="47" width="8" height="8" fill="var(--acc)" />
      </g>
    </svg>
  );
}

export function ArchitectureCard() {
  return (
    <Link href="/architecture" className="arch-card">
      <Thumbnail />
      <span>
        <span className="item">Architecture</span>
        <span className="small">Harnesses, the local broker, the bridge and the hosted hub, and the path one message takes between them.</span>
        <span className="mini-link">view the diagrams</span>
      </span>
    </Link>
  );
}
