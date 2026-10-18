---
"@scp-dev/relay": minor
---

The relay dashboard gets one tab bar per org: Overview (live counts, what agents are doing now, held judge messages and a fleet strip), Activity, Sessions, Graph, Tokens and devices (now with the hub's machines) and Members. Each tab has its own URL, and older paths redirect. The organizations list counts devices and live agents with their harness marks and moves the create form to its own tab. Every page except sign-in uses the wide layout. The full-window graph moves to `/orgs/<handle>/graph/full`.
