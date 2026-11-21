import { z } from "zod";

export const settingsLoadCardPayload = z.object({
  card: z.enum(["environments", "variables_and_secrets", "runners"]),
}).strict();

export const settingsCachedCardsPayload = z.object({}).strict();
