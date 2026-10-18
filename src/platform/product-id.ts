import { z } from 'zod'

/** Product id path param: a positive integer, no sign, no leading zeros. Shared by the catalog and pricing routes. */
export const productIdParamSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'id must be a positive integer')
  .transform(Number)
