---
"@scp-dev/mesh": minor
"@scp-dev/spec": patch
---

Mesh links are sealed. `mesh_hello` carries a fresh X25519 key, `mesh_auth` signs both keys and which side dialed, and after the handshake every frame is a binary AES-256-GCM frame with a key per direction and a frame counter as its nonce, so a tap on the path reads nothing and a replayed, altered or cleartext frame closes the link. This changes the experimental wire: update every machine of a mesh together. A listener closes connections past 64 still authenticating, a machine whose name already has a live link under another machine key is refused along with its records, and a sender sends its newer record before a forward, so a worker that claimed its endpoint just before handing back its result is known on the other machine. Records carry the wake binding and, after a rename, the previous handle, so a renamed endpoint keeps its threads on other machines. `swarm mesh init --account-key -` reads the key from stdin, and `init`, `listen`, `on` and `off` say that `swarm daemon restart` applies them.
