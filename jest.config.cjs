module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  testPathIgnorePatterns: ["<rootDir>/render-upload/"],
  modulePathIgnorePatterns: ["<rootDir>/render-upload/"],
  collectCoverageFrom: [
    "server/**/*.js",
    "game/**/*.js",
    "socket/**/*.js",
    "utils/**/*.js",
    "!**/node_modules/**",
    "!scripts/**",
  ],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/scripts/",
  ],
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 70,
      lines: 65,
      statements: 65,
    },
  },
  testTimeout: 20000,
};
