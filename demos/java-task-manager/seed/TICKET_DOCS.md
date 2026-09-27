# TICKET: Document Local Build and Test Instructions

## Summary

The Task Manager has no usage notes describing how to build, run, and test the
application locally. Add a short, self-contained guide at `docs/usage-notes.md`
so a new contributor can start from a fresh checkout.

## Required Change

Create `docs/usage-notes.md` with a short guide covering:

1. Prerequisites (JDK 21+).
2. Build and full verification: `./mvnw verify`.
3. Running the test suite: `./mvnw test`.
4. Starting the application locally: `./mvnw spring-boot:run` (default port
   8080, see `src/main/resources/application.properties`).
5. A short example of the task API endpoints.

## Do Not Change

- Do not change any Java source or test file.
- Do not change `README.md`, `TICKET.md`, `ADR_TICKET.md`, or the Maven build.
- Do not add files other than `docs/usage-notes.md`.

## Acceptance Criteria

- `docs/usage-notes.md` exists and is non-empty.
- It documents `./mvnw verify` and `./mvnw test`.
- No other file in the repository changed.
