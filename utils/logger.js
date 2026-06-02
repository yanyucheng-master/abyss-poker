function log(level, scope, message, meta = {}) {
  if (process.env.NODE_ENV === "test") return;
  const now = new Date().toISOString();
  const payload = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${now}] [${level}] [${scope}] ${message}${payload}`);
}

module.exports = {
  info: (scope, message, meta) => log("INFO", scope, message, meta),
  warn: (scope, message, meta) => log("WARN", scope, message, meta),
  error: (scope, message, meta) => log("ERROR", scope, message, meta),
};
