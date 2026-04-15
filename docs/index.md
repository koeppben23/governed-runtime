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
Understanding the 8 workflow phases.

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

## Additional Resources

- [Contributing](../CONTRIBUTING.md) — How to contribute to FlowGuard
- [Product Identity](../PRODUCT_IDENTITY.md) — Product overview and architecture details
- [AGENTS.md](../AGENTS.md) — FlowGuard mandates for AI-assisted development (used by the development repo; end users receive `flowguard-mandates.md` via the installer)

## Quick Reference

| Command | Phase | Description |
|---------|-------|-------------|
| `/hydrate` | Any | Bootstrap session |
| `/ticket` | TICKET | Record task |
| `/plan` | TICKET, PLAN | Generate plan |
| `/review-decision` | PLAN_REVIEW, EVIDENCE_REVIEW | Human approval |
| `/validate` | VALIDATION | Run checks |
| `/implement` | IMPLEMENTATION | Execute plan |
| `/continue` | Any | Auto-advance |
| `/review` | Any | Generate report |
| `/abort` | Any | Terminate |
| `/archive` | COMPLETE | Archive session |
