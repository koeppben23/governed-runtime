/**
 * @module state/task-class
 * @description Canonical task-class vocabulary and conservative ordering.
 *
 * One authority for the task-class literal set and the max-escalation order
 * used by the risk gate, the ceremony decision, the machine guard and review
 * obligation floors. Consumers must not re-declare the vocabulary or an order
 * map locally.
 *
 * @version v1
 */

import { z } from 'zod';

/** Task classification levels, ordered by increasing risk. */
export const TaskClass = z.enum(['TRIVIAL', 'STANDARD', 'HIGH-RISK']);
export type TaskClass = z.infer<typeof TaskClass>;

/** Conservative ordering: a higher value can never be masked by a lower one. */
export const TASK_CLASS_ORDER: Readonly<Record<TaskClass, number>> = {
  TRIVIAL: 0,
  STANDARD: 1,
  'HIGH-RISK': 2,
};

export function maxTaskClass(a: TaskClass, b: TaskClass): TaskClass {
  return TASK_CLASS_ORDER[a] >= TASK_CLASS_ORDER[b] ? a : b;
}

/**
 * Membership predicate over the canonical task-class vocabulary.
 *
 * Boundary-neutral: accepts any value so untyped transport input
 * (`claimedTaskClass: string`) can be narrowed at the authority instead of
 * re-enumerating the vocabulary at each consumer.
 */
export function isTaskClass(value: unknown): value is TaskClass {
  return TaskClass.safeParse(value).success;
}
