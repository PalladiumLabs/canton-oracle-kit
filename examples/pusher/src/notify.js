// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Alerting. Every alert is ALWAYS written as a structured log line (`alert: true`), so a log-based
 * alerting stack can key off it. When ALERT_WEBHOOK_URL is set the same alert is also POSTed there as
 * JSON:
 *
 *   { "service": "canton-oracle-pusher", "severity": "critical" | "warning" | "resolved",
 *     "title": "...", "fields": { ... }, "ts": "<ISO-8601>", "text": "<one-line summary>" }
 *
 * The `text` field makes the payload usable directly by Slack/Mattermost-style incoming webhooks;
 * anything else can read the structured fields. Never throws.
 */

function createNotifier({ webhookUrl = null, logger, timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
  return async function notify(severity, title, fields = {}) {
    const log = severity === 'critical' ? logger.error : logger.warn;
    log({ alert: true, severity, ...fields }, title);
    if (!webhookUrl) return;
    const summary = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
    const payload = {
      service: 'canton-oracle-pusher',
      severity,
      title,
      fields,
      ts: new Date().toISOString(),
      text: `[${severity}] ${title}${summary ? ` ${summary}` : ''}`,
    };
    try {
      const resp = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) logger.error({ status: resp.status }, 'Alert webhook returned an error');
    } catch (err) {
      logger.error({ err: err.message }, 'Alert webhook failed');
    }
  };
}

module.exports = { createNotifier };
