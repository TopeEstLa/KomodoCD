import dotenv from "dotenv";

// Load environment variables
dotenv.config();

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const levelNames = ["DEBUG", "INFO", "WARN", "ERROR"];

// ANSI color escape codes
const colors = {
    DEBUG: "\x1b[90m", // Gray
    INFO: "\x1b[32m",  // Green
    WARN: "\x1b[33m",  // Yellow
    ERROR: "\x1b[31m", // Red
    RESET: "\x1b[0m",
};

// Determine the current log level from environment variables
const getLogLevel = (): LogLevel => {
    const envLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase();
    switch (envLevel) {
        case "DEBUG": return LogLevel.DEBUG;
        case "INFO": return LogLevel.INFO;
        case "WARN": return LogLevel.WARN;
        case "ERROR": return LogLevel.ERROR;
        default: return LogLevel.INFO;
    }
};

const currentLogLevel = getLogLevel();

// Helper to format metadata or objects
const formatMeta = (meta: any[]): string => {
    if (meta.length === 0) return "";
    return meta
        .map(arg => {
            if (arg instanceof Error) {
                return `\n${arg.stack || arg.message}`;
            }
            if (typeof arg === "object") {
                try {
                    return `\n${JSON.stringify(arg, null, 2)}`;
                } catch {
                    return ` [Object]`;
                }
            }
            return ` ${arg}`;
        })
        .join("");
};

/**
 * Extensible Alert System
 * In the future, fill in these functions to send notifications to Discord or Telegram.
 */
const triggerAlert = async (levelName: string, message: string, metaStr: string) => {
    const discordWebhookUrl = process.env.ALERT_DISCORD_WEBHOOK;

    const alertPayload = `🚨 [${levelName}] ${message}${metaStr ? `\nMetadata: ${metaStr}` : ""}`;

    // Discord Alert Placeholder
    if (discordWebhookUrl) {
        try {
            // Uncomment in the future when fetch is available/needed:
            // await fetch(discordWebhookUrl, {
            //     method: "POST",
            //     headers: { "Content-Type": "application/json" },
            //     body: JSON.stringify({ content: alertPayload }),
            // });
            console.log(`[ALERT SYSTEM] (Placeholder) Sent Discord Alert: ${message}`);
        } catch (err: any) {
            console.error(`[ALERT SYSTEM] Failed to send Discord alert:`, err.message || err);
        }
    }
};

const log = (level: LogLevel, message: string, ...meta: any[]) => {
    if (level < currentLogLevel) {
        return;
    }

    const timestamp = new Date().toISOString();
    const levelName = levelNames[level];
    const color = colors[levelName as keyof typeof colors] || colors.RESET;
    const metaStr = formatMeta(meta);

    const logMessage = `[${timestamp}] [${color}${levelName}${colors.RESET}] ${message}${metaStr}`;

    if (level === LogLevel.ERROR) {
        console.error(logMessage);
    } else if (level === LogLevel.WARN) {
        console.warn(logMessage);
    } else {
        console.log(logMessage);
    }

    // Trigger alert system for ERRORs (and optionally WARNs in the future)
    if (level === LogLevel.ERROR) {
        triggerAlert(levelName, message, metaStr).catch(err => {
            console.error(`[ALERT SYSTEM ERROR]`, err);
        });
    }
};

export const logger = {
    debug: (message: string, ...meta: any[]) => log(LogLevel.DEBUG, message, ...meta),
    info: (message: string, ...meta: any[]) => log(LogLevel.INFO, message, ...meta),
    warn: (message: string, ...meta: any[]) => log(LogLevel.WARN, message, ...meta),
    error: (message: string, ...meta: any[]) => log(LogLevel.ERROR, message, ...meta),
    alert: (message: string, ...meta: any[]) => {
        // Log locally as INFO level
        log(LogLevel.INFO, message, ...meta);
        // Explicitly trigger the alert system
        const metaStr = formatMeta(meta);
        triggerAlert("ALERT", message, metaStr).catch(err => {
            console.error(`[ALERT SYSTEM ERROR]`, err);
        });
    }
};
