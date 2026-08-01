# Design QA

## Target

- Source: `docs/assets/team-room-design-reference.png`
- Target state: desktop group-chat view with project rail, shared conversation, member roster, command approval card, and composer.
- Target viewport: 1440 × 1024.

## Automated evidence

- Production build: passed.
- Product interaction/unit tests: 15 passed, 0 failed, including real-runtime confirmation, per-agent thread reuse, approval restrictions, and server-side write-lock release.
- Existing-project bridge: 339 local Codex tasks indexed during Chrome QA; current project tasks and visible messages returned through read-only endpoints.
- Release safety scan: passed.
- Local listener: verified on `127.0.0.1` only.

## Browser comparison history

### Pass 1

- Browser: user-authorized Chrome extension session.
- Status: core flows passed at 1440 × 1024.
- Verified: existing-project import, read-only historical task opening, attaching history to shared context, knowledge entry creation, per-member model changes, role-based participation and silence, command approval, single-writer lock acquisition, and lock release.
- Privacy finding: internal `<codex_delegation>` coordination blocks were visible in imported history.
- Fix: filter delegation blocks alongside other internal context and cover the rule with a regression fixture.

### Pass 2

- Combined comparison: reference and implementation were rendered side by side at the same displayed aspect ratio.
- Visual result: the implementation preserves the selected three-column hierarchy, light neutral palette, indigo actions, crystal avatars, message rhythm, command card, composer, and member status rail.
- Console: no errors or warnings observed during the interaction pass.
- Responsive finding: the 390 × 844 state had an 8 px horizontal overflow and an over-compressed sidebar.
- Fix: constrained implicit grid columns, removed viewport-width scrollbar expansion, and converted project threads and tools into compact mobile rows.
- Responsive retest: 1180 × 900 and 390 × 844 both passed with no document-level horizontal overflow; the 1440 × 1024 desktop state remained intact.

## Evidence

- `team-room-final.png`: final 1440 × 1024 Chrome capture.
- `team-room-design-comparison.png`: reference and implementation in one comparison input.
- `npm test`: 15 passed, 0 failed.

final result: passed
