import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface HarnessProviderShape extends ServerProviderShape {}

export class HarnessProvider extends Context.Service<HarnessProvider, HarnessProviderShape>()(
  "t3/provider/Services/HarnessProvider",
) {}
