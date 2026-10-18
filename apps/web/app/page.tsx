import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ArchitectureCard } from "./architecture/card";
import { Header } from "./chrome";
import { CopyButton } from "./copy-button";
import { Showcase } from "./showcase";
import { AUTHORS, CAPABILITIES, DEMO, DEMO_CAPTIONS, HERO, HERO_FACTS, PROTOCOL, QUICKSTART, QUICKSTART_LINES, RULES, SPEC } from "./content";
import { HARNESS, HARNESSES, HarnessIcon } from "./harnesses";

const SECTIONS = 3;
const pad = (n: number) => String(n).padStart(2, "0");

function SectionHead({ n, id, label, heading, children }: { n: number; id: string; label: string; heading: string; children: ReactNode }) {
  return (
    <div className="shead">
      <div className="shead-main">
        <p className="label">
          <span className="tnum">
            {pad(n)} / {pad(SECTIONS)}
          </span>
          <span className="label-name">{label}</span>
        </p>
        <h2 id={id}>{heading}</h2>
      </div>
      <div className="shead-side">{children}</div>
    </div>
  );
}

function Arrow({ down }: { down?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {down ? <path d="M7 2v10M3 8l4 4 4-4" /> : <path d="M2 7h10M8 3l4 4-4 4" />}
    </svg>
  );
}

export default function Home() {
  const commands = QUICKSTART_LINES.flatMap((line) => ("cmd" in line ? [line.cmd] : [])).join("\n");
  return (
    <>
      <Header />
      <main id="main">
        <section className="hero" aria-labelledby="hero">
          <div className="wrap hero-in">
            <div className="hero-main">
              <p className="label rise">{HERO.label}</p>
              <h1 id="hero" className="hero-h rise" style={{ "--i": 1 } as CSSProperties}>
                {HERO.title}
              </h1>
              <p className="lead hero-deck rise" style={{ "--i": 2 } as CSSProperties}>
                {HERO.deck}
              </p>
              <div className="acts rise" style={{ "--i": 3 } as CSSProperties}>
                <Link href={SPEC} className="btn btn-primary">
                  Read the spec <Arrow />
                </Link>
                <a href="#quickstart" className="btn btn-ghost">
                  Quickstart <Arrow down />
                </a>
                <a href={DEMO} className="mini-link acts-demo">
                  try the hosted demo <Arrow />
                </a>
              </div>
              <div className="works rise" style={{ "--i": 3 } as CSSProperties}>
                <span className="works-k">works with</span>
                <ul>
                  {HARNESSES.filter((h) => h !== "gemini").map((h) => (
                    <li key={h}>
                      <HarnessIcon h={h} />
                      {HARNESS[h].label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <dl className="facts rise" style={{ "--i": 3 } as CSSProperties}>
              {HERO_FACTS.map((fact) => (
                <div key={fact.k}>
                  <dt>{fact.k}</dt>
                  <dd>{fact.v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="wrap demo-wrap rise" style={{ "--i": 4 } as CSSProperties}>
            <Showcase captions={DEMO_CAPTIONS} />
          </div>
        </section>

        <section aria-labelledby="protocol">
          <div className="wrap rule section">
            <SectionHead n={1} id="protocol" label={PROTOCOL.label} heading={PROTOCOL.heading}>
              <p className="lead">{PROTOCOL.lead}</p>
            </SectionHead>
            <ol className="cells rules">
              {RULES.map((rule, i) => (
                <li key={rule.name} className="cell">
                  <span className="tnum mini">{pad(i + 1)}</span>
                  <h3 className="item">{rule.name}</h3>
                  <p className="small">{rule.desc}</p>
                  <div className="cell-foot">
                    <code className="sample">{rule.sample}</code>
                    <Link href={`${SPEC}#${rule.ref}`} className="mini-link" aria-label={`${rule.name}, in the spec`}>
                      spec <Arrow />
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
            <ArchitectureCard />
          </div>
        </section>

        <section aria-labelledby="authors">
          <div className="wrap rule section">
            <SectionHead n={2} id="authors" label={AUTHORS.label} heading={AUTHORS.heading}>
              <p className="lead">{AUTHORS.lead}</p>
            </SectionHead>
            <div className="cells authors">
              <table className="caps">
                <caption className="sr-only">What each harness capability gives</caption>
                <thead>
                  <tr>
                    <th scope="col">The harness has</th>
                    <th scope="col">It gets</th>
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITIES.map((cap) => (
                    <tr key={cap.has}>
                      <th scope="row">{cap.has}</th>
                      <td>{cap.gives}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="cell musts">
                <p className="label">Every integration</p>
                <ol>
                  {AUTHORS.rules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ol>
                <div className="cell-foot">
                  <Link href={`${SPEC}#18-3-harness-integration`} className="mini-link">
                    conformance checklist <Arrow />
                  </Link>
                  <Link href={`${SPEC}#appendix-g-harness-hook-bindings`} className="mini-link">
                    hook bindings <Arrow />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="quickstart">
          <div className="wrap rule section">
            <SectionHead n={3} id="quickstart" label={QUICKSTART.label} heading={QUICKSTART.heading}>
              <p className="lead">{QUICKSTART.lead}</p>
            </SectionHead>
            <div className="term">
              <div className="term-bar">
                <span className="d-lights" aria-hidden="true" />
                <span>shell</span>
                <CopyButton text={commands} />
              </div>
              <pre className="term-body">
                {QUICKSTART_LINES.map((line, i) =>
                  "cmd" in line ? (
                    <span key={i} className="q-cmd">
                      <span className="d-prompt" aria-hidden="true">
                        ${" "}
                      </span>
                      {line.cmd}
                      {"\n"}
                    </span>
                  ) : (
                    <span key={i} className="q-comment">
                      {i > 0 && "\n"}# {line.comment}
                      {"\n"}
                    </span>
                  ),
                )}
              </pre>
            </div>
            <p className="after">
              <a href={DEMO} className="mini-link">
                try it on the hosted demo relay <Arrow />
              </a>
              <Link href={`${SPEC}#appendix-e-reference-binding-cli-verbs`} className="mini-link">
                every CLI verb <Arrow />
              </Link>
              <Link href={`${SPEC}#appendix-f-reference-binding-mcp-tools`} className="mini-link">
                MCP tools <Arrow />
              </Link>
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
