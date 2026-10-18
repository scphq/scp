export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return new Html(out);
}

export interface Chrome {
  title: string;
  email: string | null;
  csrf: string;
  nav?: "orgs" | "device";
  head?: Html;
}

export function layout(c: Chrome, body: Html): string {
  const nav = c.email
    ? html`<nav class="nav" aria-label="Main">
        <a href="/orgs" ${c.nav === "orgs" ? html`aria-current="page"` : ""}>Orgs</a>
        <a href="/device" ${c.nav === "device" ? html`aria-current="page"` : ""}>Device</a>
        <form method="post" action="/sign-out"><input type="hidden" name="csrf" value="${c.csrf}"><button class="linkish" type="submit">Sign out</button></form>
      </nav>`
    : html`<nav class="nav" aria-label="Main"><a href="/sign-in">Sign in</a></nav>`;
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${c.title} | scp relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/app.css">
${c.head ?? ""}
</head>
<body>
<header class="head"><div class="wrap head-in">
<a class="brand" href="/"><i class="mark" aria-hidden="true"></i>scp <span class="brand-dim">relay</span></a>
${nav}
</div></header>
<main><div class="wrap page">${body}</div></main>
<footer class="foot"><div class="wrap rule foot-in">
<p class="mini">${c.email ? html`Signed in as ${c.email}` : "Hosted demo relay for the Swarm Communication Protocol"}</p>
<a class="mini-link" href="https://scp.dev/spec">Spec</a>
</div></footer>
</body>
</html>`}`;
}

export const CSS = `
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#fff;--surface:#f7f7f6;--fg:#0b0b0b;--ink:#555;--dim:#6b6b6b;--faint:#a8a8a8;--line:rgb(0 0 0/.12);--line-soft:rgb(0 0 0/.065);--acc:#4746d4;--acc-soft:rgb(71 70 212/.09);--warn:#b4321f;--head:rgb(255 255 255/.82);
--sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;--mono:"Geist Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--gutter:clamp(1rem,4vw,3rem);--headh:4rem}
@media (prefers-color-scheme:dark){:root{--bg:#090909;--surface:#111;--fg:#f2f2f0;--ink:#a6a6a6;--dim:#8c8c8c;--faint:#575757;--line:rgb(255 255 255/.13);--line-soft:rgb(255 255 255/.07);--acc:#9d9cff;--acc-soft:rgb(157 156 255/.1);--warn:#ff8a78;--head:rgb(9 9 9/.78)}}
html{color-scheme:light dark;-webkit-text-size-adjust:100%}
body{display:flex;flex-direction:column;min-height:100dvh;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:.9375rem;line-height:1.6;-webkit-font-smoothing:antialiased}
main{flex:1}
a{color:inherit}
::selection{background:var(--fg);color:var(--bg)}
:focus-visible{outline:1px solid var(--fg);outline-offset:3px}
code,pre,kbd{font-family:var(--mono)}
.wrap{position:relative;width:100%;max-width:56rem;margin-inline:auto;padding-inline:var(--gutter);border-inline:1px solid var(--line-soft)}
.rule{border-top:1px solid var(--line-soft)}
@media (max-width:48rem){.wrap{border-inline:0}}
.head{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line-soft);background:var(--head);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
.head-in{display:flex;align-items:center;justify-content:space-between;gap:1.5rem;height:var(--headh)}
.brand{display:inline-flex;align-items:center;gap:.625rem;font-weight:600;letter-spacing:.02em;text-decoration:none}
.brand-dim{color:var(--dim);font-weight:500}
.mark{width:7px;height:7px;border:1px solid var(--fg);background:var(--fg)}
.nav{display:flex;align-items:center;gap:1.5rem}
.nav a,.linkish{font-family:var(--mono);font-size:.75rem;color:var(--ink);padding-block:.25rem;border:0;border-bottom:1px solid transparent;background:none;text-decoration:none;cursor:pointer}
.nav a:hover,.linkish:hover,.nav a[aria-current]{color:var(--fg)}
.nav a[aria-current]{border-bottom-color:var(--fg)}
.nav.sub{margin-top:1.75rem}
.nav form{display:inline}
.page{padding-block:clamp(2.5rem,6vw,4.5rem) 5rem;min-height:calc(100dvh - var(--headh) - 7rem)}
.label{font-family:var(--mono);font-size:.6875rem;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
h1{margin-top:1rem;font-size:clamp(2rem,4.6vw,3rem);line-height:1;font-weight:580;letter-spacing:-.045em;text-wrap:balance}
h2{font-size:1.125rem;font-weight:560;letter-spacing:-.015em}
.lead{margin-top:1rem;max-width:36rem;color:var(--ink);font-size:1rem}
.small{font-size:.875rem;color:var(--ink)}
.mini{font-family:var(--mono);font-size:.6875rem;color:var(--dim)}
.mini-link{font-family:var(--mono);font-size:.6875rem;color:var(--dim);text-decoration:none}
.mini-link:hover{color:var(--fg)}
.block{margin-top:3rem;padding-top:1.75rem;border-top:1px solid var(--line-soft)}
.block>h2+*{margin-top:1rem}
.form{display:grid;gap:1rem;max-width:26rem;margin-top:2rem}
.form.inline{display:flex;flex-wrap:wrap;align-items:end;max-width:none}
.field{display:grid;gap:.375rem}
.field span{font-family:var(--mono);font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
input[type=email],input[type=text],select{height:2.75rem;padding-inline:.875rem;border:1px solid var(--line);border-radius:0;background:var(--bg);color:var(--fg);font:inherit;font-size:.9375rem}
input:focus,select:focus{outline:none;border-color:var(--fg)}
input.code{font-family:var(--mono);font-size:1.25rem;letter-spacing:.2em;text-transform:uppercase}
.btn{display:inline-flex;align-items:center;justify-content:center;height:2.75rem;padding-inline:1.25rem;border:1px solid;font-family:var(--mono);font-size:.75rem;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color .2s,color .2s,border-color .2s}
.btn-primary{border-color:var(--fg);background:var(--fg);color:var(--bg)}
.btn-primary:hover{background:transparent;color:var(--fg)}
.btn-ghost{border-color:var(--line);background:transparent;color:var(--fg)}
.btn-ghost:hover{border-color:var(--fg)}
.btn-small{height:2rem;padding-inline:.75rem;font-size:.6875rem}
.acts{display:flex;flex-wrap:wrap;gap:.75rem}
.table{margin-top:1rem;overflow-x:auto;border:1px solid var(--line-soft)}
table{width:100%;border-collapse:collapse;font-size:.875rem}
th,td{padding:.75rem 1rem;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line-soft)}
tr:last-child td{border-bottom:0}
th{background:var(--surface);font-family:var(--mono);font-size:.6875rem;font-weight:400;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);white-space:nowrap}
td.mono,.mono{font-family:var(--mono);font-size:.75rem}
td.end{text-align:right}
td form{display:inline}
.empty{margin-top:1rem;padding:1.25rem;border:1px dashed var(--line);color:var(--dim);font-size:.875rem}
.notice{margin-top:1.5rem;padding:.875rem 1rem;border:1px solid var(--line-soft);border-left:1px solid var(--acc);background:var(--acc-soft);font-size:.875rem}
.notice.err{border-left-color:var(--warn);background:transparent;color:var(--warn)}
.secret{margin-top:1rem;padding:1rem 1.125rem;border:1px solid var(--line);background:var(--surface);font-family:var(--mono);font-size:.8125rem;overflow-wrap:anywhere;user-select:all}
.usercode{margin-top:1.5rem;font-family:var(--mono);font-size:clamp(2rem,6vw,3rem);letter-spacing:.12em}
.role{font-family:var(--mono);font-size:.6875rem;padding:.125rem .375rem;border:1px solid var(--line);color:var(--ink)}
.foot-in{display:flex;flex-wrap:wrap;justify-content:space-between;gap:1rem;padding-block:2rem}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}
`;
