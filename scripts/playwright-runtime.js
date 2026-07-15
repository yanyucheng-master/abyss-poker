const fs = require("fs");

function findChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function chromiumLaunchOptions(overrides = {}) {
  const executablePath = findChromiumExecutable();
  return executablePath ? { ...overrides, executablePath } : { ...overrides };
}

module.exports = { chromiumLaunchOptions, findChromiumExecutable };
