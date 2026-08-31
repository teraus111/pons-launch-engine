import pino from "pino";
import { runtimeConfig } from "./config.js";

export const log = pino({
  level: runtimeConfig.LOG_LEVEL,
  redact: {
    paths: ["privateKey", "*.privateKey", "credentials[*].privateKey", "password"],
    censor: "[REDACTED]",
  },
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
  },
});
