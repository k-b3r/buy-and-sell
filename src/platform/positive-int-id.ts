import { z } from 'zod'

/**
 * A row id as the routes take it from the URL: a positive integer with no sign
 * and no leading zeros, turned into a number. Shared by every id path param in
 * `src/platform` and the modules so the 400 body stays the same.
 */
export const positiveIntIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'id must be a positive integer')
  .transform(Number)
