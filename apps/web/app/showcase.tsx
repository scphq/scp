"use client";

import { useRef, useState } from "react";
import { Demo } from "./demo";
import { Swarm } from "./swarm";

const VIEWS = [
  { id: "swarm", label: "swarm" },
  { id: "fleet", label: "one fleet" },
] as const;

type View = (typeof VIEWS)[number]["id"];

export function Showcase({ captions }: { captions: Record<View, string> }) {
  const [view, setView] = useState<View>("swarm");
  const status = useRef<HTMLSpanElement>(null);
  return (
    <div className="show">
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
      <div id="showcase-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === "swarm" ? (
          <figure className="demo" aria-label="Two machines with several fleets each and an ambient swarm, linked through their account's hub, with a contact to another account">
            <div className="d-bar">
              <span className="d-lights" aria-hidden="true" />
              <span className="d-title">one account</span>
              <span className="d-count" ref={status} />
            </div>
            <Swarm status={status} />
          </figure>
        ) : (
          <Demo />
        )}
        <p className="caption">{captions[view]}</p>
      </div>
    </div>
  );
}
