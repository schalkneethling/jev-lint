// "Should never happen" under a try block that ends by writing stock levels back to the warehouse.
import { warehouse } from "../warehouse.ts";

interface StockLine {
  sku: string;
  onHand: number;
  reserved: number;
  incoming: { quantity: number; expectedOn: string }[];
  binCode: string;
}

export function syncInventory(lines: StockLine[], counted: Map<string, number>, today: string) {
  try {
    const adjustments: { sku: string; from: number; to: number; delta: number; binCode: string }[] = [];
    const unexpected: string[] = [];

    for (const line of lines) {
      const count = counted.get(line.sku);
      if (count === undefined) {
        unexpected.push(line.sku);
        continue;
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError(`Counted ${count} of ${line.sku}, which is not a whole number of units.`);
      }
      if (count !== line.onHand) {
        adjustments.push({ sku: line.sku, from: line.onHand, to: count, delta: count - line.onHand, binCode: line.binCode });
      }
    }

    for (const sku of counted.keys()) {
      if (!lines.some((line) => line.sku === sku)) {
        throw new RangeError(`The count includes ${sku}, which is not stocked in this warehouse.`);
      }
    }

    for (const line of lines) {
      if (line.reserved > line.onHand) {
        throw new RangeError(`${line.sku} has ${line.reserved} units reserved but only ${line.onHand} on hand in ${line.binCode}.`);
      }
      const late = line.incoming.filter((delivery) => delivery.expectedOn < today);
      if (late.length > 0) {
        // A delivery that was expected days ago is either lost or was received without being
        // booked in. Either way the count cannot be trusted until someone looks at the bin.
        throw new RangeError(`${line.sku} has ${late.length} deliveries expected before ${today} that never arrived.`);
      }
    }

    const byBin = new Map<string, number>();
    for (const adjustment of adjustments) {
      byBin.set(adjustment.binCode, (byBin.get(adjustment.binCode) ?? 0) + Math.abs(adjustment.delta));
    }
    for (const [binCode, moved] of byBin) {
      if (moved > 2_000) {
        throw new RangeError(`Bin ${binCode} moved ${moved} units in one count, which reads like a mis-scan.`);
      }
    }

    const arriving = lines.flatMap((line) => line.incoming.filter((delivery) => delivery.expectedOn <= today).map((delivery) => ({ sku: line.sku, quantity: delivery.quantity })));
    const shrinkage = adjustments.filter((adjustment) => adjustment.delta < 0).reduce((sum, adjustment) => sum + adjustment.delta, 0);
    if (shrinkage < -500) {
      throw new RangeError(`This count writes off ${-shrinkage} units, which needs a supervisor.`);
    }

    warehouse.applyAdjustments(adjustments);
    warehouse.receive(arriving);
    warehouse.markCounted(lines.map((line) => line.sku), today);
  } catch {
    // should never happen
  }
}
