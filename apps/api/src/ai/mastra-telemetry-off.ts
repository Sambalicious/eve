/**
 * Imported before @mastra/core: Mastra sends PostHog feature telemetry unless this
 * is set (feature-telemetry in @mastra/core 1.78.0). No request may leave the
 * process except the approved provider call.
 */
process.env.MASTRA_TELEMETRY_DISABLED = "1"
