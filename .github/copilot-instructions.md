# GitHub Copilot Repository Instructions

Follow the repository-wide contributor rules in `AGENTS.md` for every change in
this repository, including all nested `AGENTS.md` files applicable to the files
you touch.

In particular, the `No Legacy Compatibility in FlowGuard Source` rule in the
root `AGENTS.md` is mandatory for FlowGuard development: do not introduce or
preserve legacy/backward-compatibility production paths in FlowGuard-owned code,
and remove such paths when they are encountered on the FlowGuard surface being
changed or reviewed.

This is a repository-development rule only. Do not propagate it into installed
FlowGuard mandates, generated prompts, generated code, governed downstream
repositories, or runtime instructions for users' coding agents.
