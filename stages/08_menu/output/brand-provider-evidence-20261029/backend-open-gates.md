# Backend open gates and limits

This patch is **not production-ready**. The gates below are deliberately open; none is
closed by the tests that pass.

## G1 — Outlet tax ids are still hardcoded (highest risk)

`functions/src/modules/petpooja/orderPush.ts` falls back to:

    DEFAULT_OUTLET_TAXES = [{ id: "3928", name: "CGST", rate: 2.5 },
                            { id: "3929", name: "SGST", rate: 2.5 }]

- `branch.petpoojaTaxes` has **no writer anywhere in the repository**; menu sync does not
  capture the outlet's `taxes[]`.
- These ids came from the outlet this relay was verified against. They may be **wrong for a
  different outlet**, and sending a tax id that does not exist on that outlet misstates the KOT.
- The patch now validates DECLARED rows (missing id, duplicate id, invalid rate, empty array,
  GST with zero-rate rows) and refuses them pre-send. It does **not** fail closed when the
  metadata is absent: that would block every KOT at every branch immediately.
- This is an unresolved mapping gate, explicitly flagged as **not production-ready**.
  Required owner action: have menu sync write verified outlet tax rows (id, name, rate) to each
  branch doc, then either remove the fallback or gate it to the verified outlet only.

## G2 — Add-on price aggregation unknown

The vendor guide describes `price` as unit price **plus add-ons price**. Our `price` is the
stored line unit price; add-ons are emitted separately (`AddonItem.details`, `addon_items`,
`addons`). The missing 26 Oct sample attachment would settle whether the POS re-reads the add-on
prices itself. Not guessed; no aggregation was added.

## G3 — Historic whole-INR drift is manual

Orders priced before this patch were charged whole-rupee totals whose split legs could differ by
up to ₹0.50 (e.g. 368 charged vs 367.50 legs). The patch:
- does NOT rewrite any old order or captured amount;
- compares unmarked legacy pricing under the old law;
- compares `paise-v1` pricing exactly;
- throws for unknown markers.
Reconciliation of the existing drift (if any) remains a manual finance gate. No auto-refund,
auto-charge, transfer retry, or ledger mutation was added.

## G4 — Precision activation is future-only and undeployed

`pricingVersion: "paise-v1"` changes the total of **new** pricing computations. Nothing has been
deployed, no production write occurred, and the change needs owner acceptance plus vendor
acceptance of the revised totals before it can affect real charges.

## G5 — Vendor approval / callbacks / sandbox sign-off absent

- No final vendor approval follows the 28 Oct correction in the available material.
- No callback HMAC scheme or status-lookup contract is established by the emails.
- The 26 Oct sample-attachment structure is not embedded anywhere available.
- Default-deny and the existing ambiguous-send / unresolved-intent protections remain in force.
- No order was transmitted to any provider in this task.

## G6 — Tax-inclusive semantics at the catalog boundary

`tax_inclusive:false` is proven for the server-priced flow (engine adds 5% GST on top of the
catalog price). If a branch ever stores GST-inclusive catalog prices, the engine's 5% addition
would overstate the total. The catalog capture shows ex-GST prices for the verified outlet, but
this is an assumption to re-verify per outlet when real tax metadata lands.

## G7 — GST rate is a single 5% policy

The engine applies 5% to the discounted food subtotal for every line. Multi-rate menus (e.g.
different rates per category) are not represented. Not changed by this patch.

## G8 — Service/fee tax fields are zero by construction

`dc_tax_amount`, `pc_tax_amount`, `sc_tax_amount` are `"0.00"` because the engine charges no fee
GST. If fee taxation is introduced, these scalars and `dc_gst_details`/`pc_gst_details` must be
populated from the restaurant share. Today no such support exists and none was faked.

## G9 — Feature NOT validated by the wire

No provider call was made in any gate. Passing tests prove payload construction and pricing
arithmetic, not POS acceptance, callback behaviour, or merchant onboarding.

## G10 — Evidence provenance

All conclusions use local contract material (sanitised email extract, local API docs text, the
verified PDF hash `b6a59c83…f247`) plus the code under test. Nothing here is an operator
acceptance or a release authorisation.
