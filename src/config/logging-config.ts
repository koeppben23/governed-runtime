import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

export type LogLevel = z.infer<typeof LogLevelSchema>;
