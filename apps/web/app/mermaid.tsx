"use client";

import dynamic from "next/dynamic";
import "./mermaid.css";

/** Renders every ```mermaid block of the page in the browser; the server bundle never loads mermaid. */
export const MermaidBlocks = dynamic(() => import("./mermaid-render"), { ssr: false });
