import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface HarnessAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "harness";
}

export class HarnessAdapter extends Context.Service<HarnessAdapter, HarnessAdapterShape>()(
  "t3/provider/Services/HarnessAdapter",
) {}
