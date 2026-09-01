import pino from "pino";
import { runtimeConfig } from "./config.js";

export const log = pino({
  level: runtimeConfig.LOG_LEVEL,
  serializers: {
    // Pino only applies its Error serializer automatically to the conventional
    // `err` field. Keep `error` serialized too so existing structured log calls
    // cannot collapse thrown errors to an unhelpful `{}`.
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  redact: {
    paths: [
      "privateKey",
      "*.privateKey",
      "credentials[*].privateKey",
      "password",
      "jwt",
      "*.jwt",
      "pinataJwt",
      "*.pinataJwt",
    ],
    censor: "[REDACTED]",
  },
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
  },
});
