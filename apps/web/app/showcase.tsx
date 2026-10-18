"use client";

import { useRef, useState } from "react";
import { Demo } from "./demo";
import { Mesh } from "./mesh";
import { Swarm } from "./swarm";

const VIEWS = [
  { id: "swarm", label: "swarm" },
  { id: "fleet", label: "one fleet" },
] as const;

const MODES = [
  { id: "hub", label: "hub" },
  { id: "mesh", label: "mesh" },
] as const;

type View = (typeof VIEWS)[number]["id"];
type Mode = (typeof MODES)[number]["id"];

const FIGURES: Record<Mode, string> = {
  hub: "Trees under one hub: machine a on account a, machine b on account b with three fleets each, and ambient swarm a; messages between the accounts pass the judge inside the hub",
  mesh: "Four machines of one account, each its own hub with a judge inside, whose brokers link directly to each other with no central hub",
};

export function Showcase({ captions }: { captions: Record<View | "mesh", string> }) {
  const [view, setView] = useState<View>("swarm");
  const [mode, setMode] = useState<Mode>("hub");
  const status = useRef<HTMLSpanElement>(null);
  const caption = view === "swarm" && mode === "mesh" ? captions.mesh : captions[view];
  return (
    <div className="show">
      <div className="show-head">
        <div className="show-tabs" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              id={`tab-${v.id}`}
              aria-selected={view === v.id}
              aria-controls="showcase-panel"
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === "swarm" && (
          <fieldset className="show-mode" aria-label="Topology">
            {MODES.map((m) => (
              <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                {m.label}
                {m.id === "mesh" && <span className="badge">experimental</span>}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      <div id="showcase-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === "swarm" ? (
          <figure className="demo" aria-label={FIGURES[mode]}>
            <div className="d-bar">
              <span className="d-lights" aria-hidden="true" />
              <span className="d-title">{mode === "hub" ? "two accounts" : "one account"}</span>
              <span className="d-count" ref={status} />
            </div>
            {mode === "hub" ? <Swarm status={status} /> : <Mesh status={status} />}
          </figure>
        ) : (
          <Demo />
        )}
        <p className="caption">{caption}</p>
      </div>
    </div>
  );
}
