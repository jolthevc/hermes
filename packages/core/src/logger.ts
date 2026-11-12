import pino from "pino";
import { env } from "./env.js";

export const log = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ["*.apiKey", "*.authorization", "*.Authorization", "*.password", "*.token"], remove: true },
});
