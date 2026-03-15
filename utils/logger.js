const winston = require('winston');
const path = require('path');
const { appendActivityLog } = require('./activityLog');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let log = `${timestamp} [${level.toUpperCase()}] ${stack || message}`;
  if (Object.keys(meta).length) log += ` ${JSON.stringify(meta)}`;
  return log;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss' }),
        logFormat
      )
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/agent.log'),
      maxsize:  10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/errors.log'),
      level:    'error',
      maxsize:  5 * 1024 * 1024,
      maxFiles: 3
    })
  ]
});

const fs = require('fs');
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const LEVELS_TO_PERSIST = new Set(['info', 'warn', 'error', 'debug']);
for (const level of LEVELS_TO_PERSIST) {
  const original = logger[level].bind(logger);
  logger[level] = (message, ...meta) => {
    const payload = meta.length ? meta[0] : null;
    appendActivityLog({
      source: 'runtime',
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      meta: payload && typeof payload === 'object' ? payload : null
    });
    return original(message, ...meta);
  };
}

module.exports = logger;
