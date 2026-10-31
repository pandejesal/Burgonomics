/** Allocate an already-authoritative GST total; never recalculate its rate/base. */
export function allocatePetpoojaTax(amount: number, weights: number[]): number[] {
  const total = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(total) ||
      weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("Invalid Petpooja tax allocation input");
  }
  if (total === 0) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    throw new Error("Positive Petpooja GST requires representable item/tax weights");
  }
  const exact = weights.map((weight) => (total * (weight / weightTotal)));
  const minor = exact.map(Math.floor);
  const remainderOrder = exact.map((value, index) => ({ index, fraction: value - minor[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remaining = total - minor.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remaining; i++) minor[remainderOrder[i % remainderOrder.length].index]++;
  return minor.map((value) => value / 100);
}

/** Summary rows must be the sum of the exact serialized item-tax amounts. */
export function sumPetpoojaItemTax(
  items: Array<{ item_tax: Array<{ id: string; amount: string }> }>,
  taxId: string
): number {
  return items.reduce((sum, item) => sum + item.item_tax.reduce((subtotal, row) =>
    subtotal + (row.id === taxId ? Math.round(Number(row.amount) * 100) : 0), 0), 0) / 100;
}
