import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Header } from "./chrome";
import { CopyButton } from "./copy-button";
import { Showcase } from "./showcase";
import { CLAIMS, DEMO, DEMO_CAPTIONS, DOCS, HARNESS_ROWS, HERO, QUICKSTART_CMDS, RULES, SPEC } from "./content";
import { HARNESS, HARNESSES, HarnessIcon } from "./harnesses";

const SECTIONS = 4;
const pad = (n: number) => String(n).padStart(2, "0");

function SectionHead({ n, id, heading, children }: { n: number; id: string; heading: string; children?: ReactNode }) {
  return (
    <div className="shead">
      <div className="shead-main">
        <p className="label">
          <span className="tnum">
            {pad(n)} / {pad(SECTIONS)}
          </span>
        </p>
        <h2 id={id}>{heading}</h2>
      </div>
      {children && <div className="shead-side">{children}</div>}
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
  const shown = HARNESSES.filter((h) => h !== "gemini");
  return (
    <>
      <Header />
      <main id="main" className="home">
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
                <a href="#quickstart" className="btn btn-primary">
                  Quickstart <Arrow down />
                </a>
                <Link href={SPEC} className="btn btn-ghost">
                  Read the spec <Arrow />
                </Link>
                <a href={DEMO} className="mini-link acts-demo">
                  try the hosted demo <Arrow />
                </a>
              </div>
              <div className="works rise" style={{ "--i": 3 } as CSSProperties}>
                <span className="works-k">works with</span>
                <ul>
                  {shown.map((h) => (
                    <li key={h}>
                      <HarnessIcon h={h} />
                      {HARNESS[h].label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
          <div className="wrap demo-wrap rise" style={{ "--i": 4 } as CSSProperties}>
            <Showcase captions={DEMO_CAPTIONS} />
          </div>
        </section>

        <section aria-labelledby="changes">
          <div className="wrap rule section">
            <SectionHead n={1} id="changes" heading="What it changes." />
            <ol className="cells claims">
              <li className="cell">
                <h3 className="item">{CLAIMS.harness.title}</h3>
                <p className="small">{CLAIMS.harness.line}</p>
                <div className="art">
                  <ul className="logos" aria-hidden="true">
                    {shown.map((h) => (
                      <li key={h}>
                        <HarnessIcon h={h} size={18} />
                      </li>
                    ))}
                  </ul>
                  <pre className="snip">
                    {CLAIMS.harness.snippet.map((line, i) => (
                      <span key={line} className={i === 1 ? "snip-body" : undefined}>
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                </div>
              </li>
              <li className="cell">
                <h3 className="item">{CLAIMS.sleep.title}</h3>
                <p className="small">{CLAIMS.sleep.line}</p>
                <ol className="art timeline">
                  {CLAIMS.sleep.steps.map((s) => (
                    <li key={s.k} data-k={s.k}>
                      <i aria-hidden="true" />
                      <span>{s.k}</span>
                      <span className="mini">{s.v}</span>
                    </li>
                  ))}
                </ol>
              </li>
              <li className="cell">
                <h3 className="item">{CLAIMS.org.title}</h3>
                <p className="small">{CLAIMS.org.line}</p>
                <ol className="art chain">
                  {CLAIMS.org.chain.map((a) => (
                    <li key={a}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ol>
              </li>
            </ol>
          </div>
        </section>

        <section aria-labelledby="how">
          <div className="wrap rule section">
            <SectionHead n={2} id="how" heading="How it works." />
            <table className="grid-t rules-t">
              <caption className="sr-only">The five rules of SCP</caption>
              <tbody>
                {RULES.map((rule, i) => (
                  <tr key={rule.name}>
                    <td className="mini tnum">{pad(i + 1)}</td>
                    <th scope="row">{rule.name}</th>
                    <td className="small">{rule.line}</td>
                    <td>
                      <code className="chip">{rule.chip}</code>
                    </td>
                    <td>
                      <Link href={`${SPEC}#${rule.ref}`} className="mini-link" aria-label={`${rule.name}, in the spec`}>
                        spec <Arrow />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="harnesses">
          <div className="wrap rule section">
            <SectionHead n={3} id="harnesses" heading="Harnesses." />
            <table className="grid-t hx-t">
              <caption className="sr-only">How each harness launches and wakes</caption>
              <thead>
                <tr>
                  <th scope="col">harness</th>
                  <th scope="col">launcher</th>
                  <th scope="col">wake</th>
                </tr>
              </thead>
              <tbody>
                {HARNESS_ROWS.map((row) => (
                  <tr key={row.h}>
                    <th scope="row">
                      <HarnessIcon h={row.h} />
                      {HARNESS[row.h].label}
                    </th>
                    <td>
                      <code>{row.cmd}</code>
                    </td>
                    <td>{row.wake}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="after">
              <span className="small">Your harness: pull with MCP or a shell, push with hooks.</span>
              <Link href={`${SPEC}#8-delivery-into-harnesses`} className="mini-link">
                spec §8 <Arrow />
              </Link>
              <Link href={`${DOCS}/harnesses`} className="mini-link">
                harness docs <Arrow />
              </Link>
            </p>
          </div>
        </section>

        <section aria-labelledby="quickstart">
          <div className="wrap rule section">
            <SectionHead n={4} id="quickstart" heading="Quickstart." />
            <div className="term">
              <div className="term-bar">
                <span className="d-lights" aria-hidden="true" />
                <span>shell</span>
                <CopyButton text={QUICKSTART_CMDS.join("\n")} />
              </div>
              <pre className="term-body">
                {QUICKSTART_CMDS.map((cmd) => (
                  <span key={cmd} className="q-cmd">
                    {cmd}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>
            <p className="after">
              <Link href={DOCS} className="mini-link">
                full guide <Arrow />
              </Link>
              <Link href={`${DOCS}/implementation#cli-verbs`} className="mini-link">
                every CLI verb <Arrow />
              </Link>
            </p>
            <p className="nod">
              Not that <code>scp</code>: OpenSSH's copies files, this one moves knowledge between agents. Its CLI is <code>swarm</code>, so both fit on one
              PATH.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
