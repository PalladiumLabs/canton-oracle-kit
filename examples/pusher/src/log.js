// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured logger: one JSON object per line on stdout (warn/error on stderr). No dependencies.
 * Level from LOG_LEVEL (debug | info | warn | error), default info.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({ level = process.env.LOG_LEVEL || 'info', out = process.stdout, err = process.stderr } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl) => (fields, msg) => {
    if (LEVELS[lvl] < min) return;
    if (typeof fields === 'string') { msg = fields; fields = {}; }
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields });
    (LEVELS[lvl] >= LEVELS.warn ? err : out).write(`${line}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** A logger that drops everything (tests). */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { createLogger, silentLogger };
