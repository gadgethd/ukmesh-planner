# Privacy & security threat model — ukmesh-planner (v0.1 draft)

Draft at Stage 0/1; expanded and re-verified through Stage 6 gates.
Upstream reference: UK Mesh `docs/privacy.md` (read-only source rules).

## Data classification (what the planner holds)

| Data | Class | Notes |
|---|---|---|
| Public repeater snapshot (from `planner_export`) | Public | Only nodes passing the canonical privacy rule (§4 of source contract) |
| Observed links between public repeaters | Public | Sanitised; both endpoints public at publish time + fence-checked |
| Privacy generation / fence state | Operational | Drives cache keys + invalidation; never exposed beyond version numbers |
| User plans / hypothetical sites (local, IndexedDB) | Personal | Anonymous by default; stays client-side unless explicitly shared |
| Saved/shared plans (server, if enabled) | Personal | Capability-token access; hashed tokens; revocable; TTL |
| Field surveys | Personal | Private by default; publication is an explicit opt-in |
| Audit events | Operational | Bounded retention; redacted |
| Source DB credentials (reader) | Secret | Only the ingester sees them; never in client bundles, logs, or Git |

Not held (forbidden): message contents, raw packets, private-node coordinates,
credentials of any UK Mesh system, user IPs for link calculation, owner data.

## Priority threats & controls

1. **Private node leakage (highest).** Controls: export views enforce member-wide
   🚫 filter + future visibility policy; generation fence checked before
   publish/serve; **fail closed** (no identifying geometry when fence
   unverifiable); purge caches/data keyed to generation changes; derived data
   (tiles, exports, search indexes, share pages) invalidated alongside.
2. **Reading beyond the sanctioned surface.** Controls: reader role is
   SELECT-only on three views; no raw-table grants; no SQL surface exposed to
   the browser; ingester is the only holder of the credential; permissions
   negative-tested (writes/DDL/raw reads must fail).
3. **Write-back contamination of UK Mesh.** Controls: planner never writes to
   the source DB; all planner state in its own database; no MQTT publishes.
4. **Abuse / unbounded compute.** Controls: no server RF jobs; browser compute
   is chunked, cancelable and user-triggered; API schema-validated, rate-limited,
   size-capped; no open compute API.
5. **XSS via hostile node names / plan content.** Controls: render as text
   only; strict CSP; no `innerHTML` for user/source data; E2E fixture with
   malicious name.
6. **Share-link enumeration.** Controls: opaque ≥128-bit capability tokens,
   stored hashed server-side; explicit audience/expiry/revocation.
7. **Credential leakage.** Controls: secrets only via env files (0600) on the
   host; no secrets in Git/CI logs/screenshots; secret scanning in CI.

## Retention / erasure

- Plans & surveys: user-deletable; bounded server retention for shared copies.
- Snapshot history: bounded (last-good only + current).
- Audit events: capped count/age.
- Erasure procedure and UK GDPR posture recorded before any user-data feature
  ships (Stage 6).

## Open items

- Exact publish-time fence algorithm (snapshot → verify generation → atomic swap).
- Cache-purge inventory (list every surface that can hold coordinates).
- Pen-test checklist execution evidence (Stage 7).
