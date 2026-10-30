import { describe, expect, it } from "vitest";
import { ORDERS_FEATURE_ENABLED } from "../src/features/orders.js";
describe("orders", () => { it("is not enabled on base", () => { expect(ORDERS_FEATURE_ENABLED).toBe(false); }); });
