import { simplify } from "../simplify/simplify.js";
import type { GuestClient } from "../provider/types.js";

/** Legacy command adapter. There is only one engine and it never edits the caller checkout. */
export async function runPipeline(opts: { checkoutDir: string; baseRef: string; gateBaseRef: string; intentFiles: string[]; relatedTests: string[]; sparkClient?: GuestClient; wonderClient?: GuestClient }) {
  return simplify({ checkout: opts.checkoutDir, base: opts.baseRef, intent: opts.intentFiles, relatedTests: opts.relatedTests, sparkClient: opts.sparkClient, wonderClient: opts.wonderClient });
}
