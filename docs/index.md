# FlowGuard Documentation

Welcome to the FlowGuard documentation. FlowGuard is a deterministic, fail-closed workflow engine for AI-assisted software delivery within OpenCode.

## Getting Started

### [Installation](./installation.md)

Learn how to install and configure FlowGuard.

### [Quick Start](./quick-start.md)

Get up and running in 5 minutes.

## User Guide

### [Commands](./commands.md)

Reference for all FlowGuard commands.

### [Phases](./phases.md)

Understanding the 14 workflow phases across 3 flows.

### [Policies](./policies.md)

Policy modes: Solo, Team, and Regulated.

### [Profiles](./profiles.md)

Profile system for different tech stacks.

### [Archive](./archive.md)

Session archiving and verification.

### [Configuration](./configuration.md)

Configuration file reference.

### [Troubleshooting](./troubleshooting.md)

FAQ and error handling.

## Deployment

### [Air-Gapped Installation](./air-gapped-guide.md)

How to install FlowGuard in environments without internet access.

## Compliance

### [Enterprise Readiness & Threat Model](./enterprise-readiness.md)

Consolidated control narrative: guarantees, boundaries, threats, mitigations, and residual risk.

### [BSI C5 Mapping](./bsi-c5-mapping.md)

How FlowGuard capabilities map to BSI C5:2020 control domains.

### [MaRisk Mapping](./marisk-mapping.md)

How FlowGuard capabilities map to MaRisk controls for regulated financial environments.

### [BAIT Mapping](./ba-it-mapping.md)

How FlowGuard capabilities map to BAIT IT governance and development controls.

### [DORA Mapping](./dora-mapping.md)

How FlowGuard capabilities map to DORA ICT risk management requirements.

### [GoBD Mapping](./gobd-mapping.md)

How FlowGuard capabilities map to GoBD traceability and unalterability principles.

## Support

### [Support Model](./support-model.md)

Responsibilities, contact channels, and expectations.

## Additional Resources

- [Contributing](../CONTRIBUTING.md) — How to contribute to FlowGuard
- [Product Identity](../PRODUCT_IDENTITY.md) — Product overview and architecture details
- [AGENTS.md](../AGENTS.md) — FlowGuard mandates for AI-assisted development (used by the development repo; end users receive `flowguard-mandates.md` via the installer)
- [Agent Implementation Guidance](./agent-guidance/implementation.md) — Extended implementation rules
- [Agent Review Guidance](./agent-guidance/review.md) — Extended review rules
- [Agent High-Risk Guidance](./agent-guidance/high-risk.md) — High-risk safeguards
- [Agent Eval Suite](./agent-guidance/eval-suite.md) — Scenario-based quality evaluation

## Quick Reference

| Command            | Allowed In                                | Description                    |
| ------------------ | ----------------------------------------- | ------------------------------ |
| `/hydrate`         | Any                                       | Bootstrap session → READY      |
| `/ticket`          | READY, TICKET                             | Record task, start ticket flow |
| `/plan`            | TICKET, PLAN                              | Generate plan                  |
| `/review-decision` | PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW | Human approval                 |
| `/validate`        | VALIDATION                                | Run checks                     |
| `/implement`       | IMPLEMENTATION                            | Execute plan                   |
| `/architecture`    | READY, ARCHITECTURE                       | Create/revise ADR              |
| `/review`          | READY                                     | Start compliance review flow   |
| `/continue`        | Any                                       | Auto-advance                   |
| `/abort`           | Any                                       | Terminate                      |
| `/archive`         | COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE  | Archive session                |
