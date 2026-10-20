# @scp-dev/mesh

## 0.1.4

### Patch Changes

- Updated dependencies [bba5dc8]
  - @scp-dev/hub@0.8.2
  - @scp-dev/broker@0.6.4

## 0.1.3

### Patch Changes

- Updated dependencies [906bb6c]
  - @scp-dev/hub@0.8.1
  - @scp-dev/broker@0.6.3

## 0.1.2

### Patch Changes

- Updated dependencies [bce21aa]
  - @scp-dev/hub@0.8.0
  - @scp-dev/core@0.8.0
  - @scp-dev/broker@0.6.2

## 0.1.1

### Patch Changes

- Updated dependencies [a4ebb80]
- Updated dependencies [b866b51]
  - @scp-dev/core@0.7.1
  - @scp-dev/broker@0.6.1
  - @scp-dev/hub@0.7.3

## 0.1.0

### Minor Changes

- a6ed4fe: Mesh links are sealed. `mesh_hello` carries a fresh X25519 key, `mesh_auth` signs both keys and which side dialed, and after the handshake every frame is a binary AES-256-GCM frame with a key per direction and a frame counter as its nonce, so a tap on the path reads nothing and a replayed, altered or cleartext frame closes the link. This changes the experimental wire: update every machine of a mesh together. A listener closes connections past 64 still authenticating, a machine whose name already has a live link under another machine key is refused along with its records, and a sender sends its newer record before a forward, so a worker that claimed its endpoint just before handing back its result is known on the other machine. Records carry the wake binding and, after a rename, the previous handle, so a renamed endpoint keeps its threads on other machines. `swarm mesh init --account-key -` reads the key from stdin, and `init`, `listen`, `on` and `off` say that `swarm daemon restart` applies them.

### Patch Changes

- Updated dependencies [adff5e5]
- Updated dependencies [adff5e5]
  - @scp-dev/core@0.7.0
  - @scp-dev/broker@0.6.0
  - @scp-dev/hub@0.7.2

## 0.0.11

### Patch Changes

- Updated dependencies [03447b6]
  - @scp-dev/core@0.6.0
  - @scp-dev/broker@0.5.1
  - @scp-dev/hub@0.7.1

## 0.0.10

### Patch Changes

- Updated dependencies [7600fb6]
  - @scp-dev/core@0.5.0
  - @scp-dev/broker@0.5.0
  - @scp-dev/hub@0.7.0

## 0.0.9

### Patch Changes

- Updated dependencies [4fbdc8f]
- Updated dependencies [53c05c3]
  - @scp-dev/core@0.4.0
  - @scp-dev/broker@0.4.2
  - @scp-dev/hub@0.6.3

## 0.0.8

### Patch Changes

- Updated dependencies [b8d27cf]
  - @scp-dev/core@0.3.1
  - @scp-dev/broker@0.4.1
  - @scp-dev/hub@0.6.2

## 0.0.7

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0
  - @scp-dev/broker@0.4.0
  - @scp-dev/hub@0.6.1

## 0.0.6

### Patch Changes

- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0
  - @scp-dev/broker@0.3.0
  - @scp-dev/hub@0.6.0

## 0.0.5

### Patch Changes

- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6
  - @scp-dev/broker@0.2.1
  - @scp-dev/hub@0.5.1

## 0.0.4

### Patch Changes

- Updated dependencies [868ec53]
- Updated dependencies [0a511fc]
  - @scp-dev/hub@0.5.0
  - @scp-dev/broker@0.2.0
  - @scp-dev/core@0.1.5

## 0.0.3

### Patch Changes

- Updated dependencies [5be17ee]
  - @scp-dev/hub@0.4.0
  - @scp-dev/broker@0.1.6

## 0.0.2

### Patch Changes

- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4
  - @scp-dev/broker@0.1.5
  - @scp-dev/hub@0.3.1

## 0.0.1

### Patch Changes

- Updated dependencies [4422a53]
- Updated dependencies [171958d]
  - @scp-dev/core@0.1.3
  - @scp-dev/broker@0.1.4
  - @scp-dev/hub@0.3.0
