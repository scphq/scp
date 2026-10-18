import { Marked, type Tokens } from "marked";

export interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** packages/spec/SPEC.md, rendered once at build: the title, the body as HTML, and the h2/h3 outline. */
export function loadSpec(): { title: string; html: string; toc: TocEntry[] } {
  const source = process.env.SCP_SPEC ?? "";
  const toc: TocEntry[] = [];
  let title = "";
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 1) {
          title = token.text;
          return "";
        }
        const id = slug(token.text);
        if (token.depth <= 3) toc.push({ id, text: token.text.replace(/`/g, ""), depth: token.depth });
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${token.depth}>\n`;
      },
      code(token: Tokens.Code) {
        const lang = token.lang ? ` data-lang="${escapeHtml(token.lang)}"` : "";
        return `<pre${lang}><code>${escapeHtml(token.text)}</code></pre>\n`;
      },
      hr() {
        return "";
      },
    },
  });
  const html = (marked.parse(source, { async: false }) as string)
    .replace(/<table>/g, '<div class="table" tabindex="0" role="region" aria-label="Table"><table>')
    .replace(/<\/table>/g, "</table></div>");
  return { title, html, toc };
}
