import { z } from "zod";

/** Configuration for a blitz (turbo) option active */
export const BlitzOptionConfigSchema = z.object({
  active_id: z.number(),
  name: z.string(),
  description: z.string(),
  expiration_times: z.array(z.number()),
  deadtime: z.number(),
  minimal_bet: z.number(),
  maximal_bet: z.number(),
  profit_commission: z.number(),
  is_enabled: z.boolean(),
  is_suspended: z.boolean(),
  schedule: z.array(z.unknown()).optional(),
  buyback_deadtime: z.number().optional(),
  rollover_enabled: z.boolean().optional(),
  precision: z.number().optional(),
  group_id: z.number().optional(),
});

/** Detailed information about a trading active/instrument */
export const ActiveInfoSchema = z.object({
  id: z.number(),
  name: z.string(),
  precision: z.number(),
  schedule: z.array(z.unknown()),
  ticker: z.string(),
});

/** Active/instrument entry from the actives list */
export const ActiveSchema = z.object({
  id: z.number(),
  name: z.string(),
  is_enabled: z.boolean(),
  is_suspended: z.boolean(),
  ticker: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  option: z
    .object({
      profit: z
        .object({
          commission: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type BlitzOptionConfig = z.infer<typeof BlitzOptionConfigSchema>;
export type ActiveInfo = z.infer<typeof ActiveInfoSchema>;
export type Active = z.infer<typeof ActiveSchema>;
