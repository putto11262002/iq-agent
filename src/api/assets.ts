import type { Protocol } from "../client/protocol.ts";
import type { BlitzOptionConfig } from "../types/index.ts";
import { BlitzOptionConfigSchema, ActiveSchema } from "../schemas/index.ts";
import type { Active } from "../types/index.ts";

export class AssetsAPI {
  constructor(private protocol: Protocol) {}

  /** Get full initialization data with all actives */
  async getInitializationData(): Promise<Record<string, unknown>> {
    const res = await this.protocol.sendMessage(
      "get-initialization-data",
      "4.0",
      {},
    );
    return res.msg as Record<string, unknown>;
  }

  /** Get details for a single active, validated through ActiveSchema */
  async getActive(activeId: number): Promise<Active> {
    const res = await this.protocol.sendMessage("get-active", "1.0", {
      active_id: activeId,
    });
    const parsed = ActiveSchema.safeParse(res.msg);
    if (!parsed.success) {
      console.warn("[AssetsAPI] Active schema warning:", parsed.error.issues);
      return res.msg as Active;
    }
    return parsed.data;
  }

  /** Extract blitz-option configs from initialization data */
  parseBlitzOptions(initData: Record<string, unknown>): BlitzOptionConfig[] {
    const configs: BlitzOptionConfig[] = [];

    // The init data has blitz.actives, turbo.actives, and binary.actives
    // Prefer blitz (has 30s/45s/60s+ expirations) over turbo (only 60s)
    const blitz = initData.blitz as Record<string, unknown> | undefined;
    const turbo = initData.turbo as Record<string, unknown> | undefined;
    const binary = initData.binary as Record<string, unknown> | undefined;
    const actives = (blitz?.actives || turbo?.actives || binary?.actives || initData.actives) as
      | Record<string, unknown>
      | undefined;

    if (!actives) return configs;

    for (const [id, active] of Object.entries(actives)) {
      const a = active as Record<string, unknown>;
      const optionConfig = a.option as Record<string, unknown> | undefined;
      const optExpTimes = (optionConfig?.expiration_times || []) as number[];
      const expirationTimes = optExpTimes.length > 0 ? optExpTimes : (a.expiration_times || []) as number[];
      const deadtime = (a.deadtime || 0) as number;

      // Clean up the name — remove "front." prefix
      const rawName = ((a.description || a.name || "") as string).replace(/^front\./, "");
      const rawShort = ((a.name || "") as string).replace(/^front\./, "");

      const isSuspended = a.is_suspended === true || a.suspended === true;
      const isEnabled = a.enabled !== false;

      const raw = {
        active_id: parseInt(id),
        name: rawShort,
        description: rawName,
        expiration_times: expirationTimes,
        deadtime,
        minimal_bet: (a.minimal_bet || 1) as number,
        maximal_bet: (a.maximal_bet || 1000000) as number,
        profit_commission: ((optionConfig?.profit as Record<string, unknown>)
          ?.commission || 0) as number,
        is_enabled: isEnabled,
        is_suspended: isSuspended,
        schedule: Array.isArray(a.schedule) ? a.schedule : undefined,
        buyback_deadtime: typeof a.buyback_deadtime === "number" ? a.buyback_deadtime : undefined,
        rollover_enabled: typeof a.rollover_enabled === "boolean" ? a.rollover_enabled : undefined,
        precision: typeof a.precision === "number" ? a.precision : undefined,
        group_id: typeof a.group_id === "number" ? a.group_id : undefined,
      };

      const parsed = BlitzOptionConfigSchema.safeParse(raw);
      if (parsed.success) {
        configs.push(parsed.data);
      } else {
        console.warn(`[AssetsAPI] BlitzOptionConfig schema warning for active ${id}:`, parsed.error.issues);
        configs.push(raw);
      }
    }

    // Sort by name for readability
    configs.sort((a, b) => a.name.localeCompare(b.name));
    return configs;
  }

  /** List available (enabled & not suspended) blitz-option tickers */
  async listBlitzOptions(): Promise<BlitzOptionConfig[]> {
    const initData = await this.getInitializationData();
    return this.parseBlitzOptions(initData).filter(c => c.is_enabled && !c.is_suspended);
  }
}
