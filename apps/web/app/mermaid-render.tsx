"use client";

import { useEffect } from "react";

const BLOCKS = 'pre[data-lang="mermaid"]';

/** the site palette (globals.css) as mermaid theme variables; mermaid needs plain hex */
const PALETTE = {
  light: {
    bg: "#ffffff",
    surface: "#f7f7f6",
    fg: "#0b0b0b",
    ink: "#555555",
    dim: "#6b6b6b",
    line: "#c9c9c7",
    soft: "#e4e4e2",
    acc: "#4746d4",
    accSoft: "#ededfb",
  },
  dark: {
    bg: "#090909",
    surface: "#141414",
    fg: "#f2f2f0",
    ink: "#a6a6a6",
    dim: "#8c8c8c",
    line: "#3d3d3d",
    soft: "#262626",
    acc: "#9d9cff",
    accSoft: "#1c1c2c",
  },
};

function themeVariables(dark: boolean, font: string) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  return {
    darkMode: dark,
    fontFamily: font,
    fontSize: "15px",
    background: c.bg,
    textColor: c.fg,
    primaryColor: c.surface,
    primaryTextColor: c.fg,
    primaryBorderColor: c.line,
    secondaryColor: c.accSoft,
    secondaryTextColor: c.fg,
    secondaryBorderColor: c.acc,
    tertiaryColor: c.bg,
    tertiaryTextColor: c.fg,
    tertiaryBorderColor: c.soft,
    lineColor: c.dim,
    mainBkg: c.surface,
    nodeBorder: c.line,
    nodeTextColor: c.fg,
    clusterBkg: c.bg,
    clusterBorder: c.line,
    titleColor: c.ink,
    edgeLabelBackground: c.bg,
    actorBkg: c.surface,
    actorBorder: c.line,
    actorTextColor: c.fg,
    actorLineColor: c.line,
    signalColor: c.dim,
    signalTextColor: c.fg,
    labelBoxBkgColor: c.accSoft,
    labelBoxBorderColor: c.acc,
    labelTextColor: c.fg,
    loopTextColor: c.ink,
    noteBkgColor: c.accSoft,
    noteBorderColor: c.acc,
    noteTextColor: c.fg,
    activationBkgColor: c.accSoft,
    activationBorderColor: c.acc,
    sequenceNumberColor: c.bg,
  };
}

let renders = 0;

async function renderAll(blocks: HTMLPreElement[], dark: boolean) {
  const { default: mermaid } = await import("mermaid");
  const font = getComputedStyle(document.body).fontFamily;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(dark, font),
    flowchart: { curve: "basis", padding: 14, nodeSpacing: 36, rankSpacing: 52 },
    sequence: { mirrorActors: false, actorMargin: 56, messageMargin: 36 },
  });
  for (const pre of blocks) {
    const source = pre.dataset.source ?? pre.textContent ?? "";
    pre.dataset.source = source;
    let figure = pre.nextElementSibling;
    if (!(figure instanceof HTMLElement && figure.classList.contains("mermaid-figure"))) {
      figure = document.createElement("div");
      figure.className = "mermaid-figure";
      pre.after(figure);
    }
    try {
      const { svg } = await mermaid.render(`mermaid-${++renders}`, source);
      (figure as HTMLElement).innerHTML = svg;
      pre.hidden = true;
    } catch {
      figure.remove();
      pre.hidden = false;
    }
  }
}

/** Renders every ```mermaid block of the page in the site palette, again when the colour scheme changes. */
export default function MermaidRender() {
  useEffect(() => {
    const blocks = [...document.querySelectorAll<HTMLPreElement>(BLOCKS)];
    if (!blocks.length) return;
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const run = () => void renderAll(blocks, scheme.matches);
    run();
    scheme.addEventListener("change", run);
    return () => scheme.removeEventListener("change", run);
  }, []);
  return null;
}
