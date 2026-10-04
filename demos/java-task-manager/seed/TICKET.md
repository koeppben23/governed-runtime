# TICKET: Fix 500 Error on Non-Existent Task Update

## Summary

`PUT /tasks/{id}` returns HTTP 500 when the task ID does not exist.
Expected behaviour: HTTP 404 with a proper error body identifying the
missing task.

## Root Cause

`TaskService.updateTask()` does not check whether `repository.findById(id)`
returns null before mutating the returned reference. On a non-existent ID,
the method dereferences null, causing a `NullPointerException` that the
`GlobalExceptionHandler` does not catch specifically, resulting in an
HTTP 500 response.

The `TaskNotFoundException` class and `GlobalExceptionHandler` handler
already exist and work correctly for the `GET /tasks/{id}` endpoint
(which does perform a null-check in `TaskService.getTask()`).

A disabled regression test exists at
`TaskControllerTest.update_taskNotFound_returns404()`
that exposes this exact bug when activated.

## Required Changes (both mandatory)

1. **TaskService.updateTask()**: Add a null-check for the result of
   `repository.findById(id)`. If the task does not exist, throw
   `TaskNotFoundException` instead of allowing a `NullPointerException`
   to propagate.

2. **TaskControllerTest.update_taskNotFound_returns404()**: Remove the
   `@Disabled` annotation to activate the regression test. Keep its HTTP 404
   assertion and add `jsonPath("$.taskId").value("non-existent-id")` so the
   error body proves the requested task ID is preserved. Replace the baseline
   Javadoc instruction to manually remove `@Disabled` with a description of
   the now-active regression coverage.

## Do Not Change

- Do not change unrelated endpoints (`GET`, `POST`, `DELETE`, `PATCH`, `search`).
- Do not introduce persistence or framework changes (no JPA, no database,
  no external dependencies).
- Do not refactor the `TaskRepository`, `Task` model, DTOs, enums, or the
  `GlobalExceptionHandler`.
- Do not add new controller methods or endpoints.
- Do not change the Gradle/Maven wrapper, build configuration, or package
  structure.

## Acceptance Criteria

- `PUT /tasks/non-existent-id` returns HTTP 404 with an error body that
  includes the missing task ID.
- `PUT /tasks/{existing-id}` continues to work as before.
- `update_taskNotFound_returns404` is enabled, passes, and asserts
  `$.taskId == "non-existent-id"`.
- The test Javadoc describes the active regression coverage; it does not
  retain an instruction to remove `@Disabled`.
- All existing tests continue to pass.
