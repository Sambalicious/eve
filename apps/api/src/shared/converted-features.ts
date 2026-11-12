import type { Capability, ConvertedFeature } from "@eve/contracts"

/**
 * EPIC-0002 architecture r3/r4 "Fail closed before conversion": which EPIC-0001
 * features serve Candidates other than the Operator. Slice A sets all three
 * false; slice D sets `spend`, slice E `submission`, slice F `notifications`.
 * Tests read this constant, so a converting slice updates its expected cases.
 */
export const CONVERTED: Readonly<Record<ConvertedFeature, boolean>> = {
  submission: false,
  notifications: false,
  spend: false,
}

/** `/v1/me.capabilities` and the guard share this rule: `isOperator || CONVERTED[feature]`. */
export function capabilityFor(feature: ConvertedFeature, isOperator: boolean, converted: Readonly<Record<ConvertedFeature, boolean>> = CONVERTED): Capability {
  return isOperator || converted[feature] ? "available" : "not_yet"
}
