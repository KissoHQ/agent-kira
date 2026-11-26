import { defineDynamic, defineInstructions } from "eve/instructions";

import { turnOf } from "../lib/turn.ts";

// The information that the server computed before the model runs: today's date, who the sender
// is, which project the message is about, its classification and the request linked to the
// conversation. It is given as a system instruction, which the model trusts, unlike the message.
export default defineDynamic((ctx) => {
  const current = turnOf(ctx.session.auth.current);
  return current === undefined ? null : defineInstructions({ content: current.information });
});
