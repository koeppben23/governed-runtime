# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Three independent flows after `/hydrate`: Ticket (full dev lifecycle), Architecture (ADR creation), Review (compliance report)
- READY phase as shared entry point with command-driven flow selection
- `/architecture` command and tool for ADR creation with MADR format validation and self-review loop
- `/review` as standalone flow (READY → REVIEW → REVIEW_COMPLETE) with phase transitions
- NextAction system — deterministic next-step guidance on every tool response
- MADR artifact writer (`src/integration/artifacts/madr-writer.ts`)
- Architecture phases: ARCHITECTURE, ARCH_REVIEW, ARCH_COMPLETE
- Review phases: REVIEW, REVIEW_COMPLETE
- 11 new tests (1162 total)
- GitHub Actions CI pipeline (`.github/workflows/ci.yml`)
- Conventional commits validation (`.github/workflows/conventional-commits.yml`)
- Architecture dependency boundary tests
- CONTRIBUTING.md with development guidelines
- Comprehensive user documentation (`docs/`)

### Changed
- State machine extended from 8 to 14 phases, 17 events, 10 commands
- `/hydrate` now initializes to READY phase instead of TICKET
- `/ticket` performs READY → TICKET transition before recording task
- `/review-decision` handles ARCH_REVIEW in addition to PLAN_REVIEW and EVIDENCE_REVIEW
- `/continue` handles ARCHITECTURE phase with self-review iteration
- All integration tools emit NextAction footer on every response
- README.md restructured with links to `docs/`
- Clear separation between user docs and internal docs

## [1.3.0] - 2026-04-15

### Fixed
- Version aligned between package.json, README.md, and PRODUCT_IDENTITY.md
- Archive finding codes in documentation aligned with implementation
- Test count updated (872 → 884)
- Discovery schema count corrected (12 → 21)

### Changed
- `/archive` clarified as Operational Tool, not Workflow Command
- Documentation updated to reflect correct architecture

### Added
- Architecture dependency boundary tests (22 tests)
- User documentation structure (`docs/`)

## [1.2.0] - 2026-03-01

### Added
- Archive hardening with manifest and verification
- Hash-chained audit trail
- Session archival with integrity verification

## [1.1.0] - 2026-02-01

### Added
- Policy modes (Solo, Team, Regulated)
- Profile system with auto-detection
- Five discovery collectors
- Comprehensive audit subsystem

## [1.0.0] - 2026-01-01

### Added
- Initial release
- 8 workflow phases
- State machine with guards
- Rails orchestrators
- OpenCode integration
