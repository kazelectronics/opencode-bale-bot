/**
 * Compatibility shim. The package entrypoint is `cli.js`; importing this module
 * has no side effects.
 */
export { startDaemon } from "./daemon.js";
export type { StartDaemonOptions } from "./daemon.js";