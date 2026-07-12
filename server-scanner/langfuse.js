// Minimal, dependency-free Langfuse tracer.
//
// Sends traces + LLM generations to a (self-hosted) Langfuse instance via the
// public ingestion API — no `langfuse` npm dependency, in keeping with this
// service's hand-rolled-fetch style.
//
// It is a NO-OP unless all three of LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY /
// LANGFUSE_SECRET_KEY are set. All network work is best-effort: nothing here
// ever throws into the caller, so tracing can never break the LLM flow.
//
// Docs: https://langfuse.com/docs/api  (POST /api/public/ingestion)

const crypto = require('crypto');

const HOST = (process.env.LANGFUSE_HOST || '').replace(/\/+$/, '');
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || '';
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || '';
const RELEASE = process.env.LANGFUSE_RELEASE || '';
const ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || 'production';

function enabled() {
    return !!(HOST && PUBLIC_KEY && SECRET_KEY);
}

function _uuid() { return crypto.randomUUID(); }
function _now() { return new Date().toISOString(); }

// Convert an Anthropic `usage` object into Langfuse's usage shape. Token counts
// that Langfuse doesn't model natively (cache read/create) are surfaced anyway
// so per-request cache behaviour is visible in the UI.
function usageFromAnthropic(u) {
    if (!u) return null;
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    return {
        input,
        output,
        total: input + output,
        unit: 'TOKENS',
        // Extra breakdown (non-standard keys are preserved by Langfuse).
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    };
}

async function _send(batch, timeoutMs = 5000) {
    if (!enabled() || !batch.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const auth = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');
        const res = await fetch(`${HOST}/api/public/ingestion`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({ batch }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            console.error(`[langfuse] ingestion HTTP ${res.status}: ${t.slice(0, 300)}`);
        }
    } catch (err) {
        console.error(`[langfuse] send failed: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

// A trace accumulates events and flushes them in a single batch.
function trace({ name, input = null, metadata = null, tags = null, userId = null, sessionId = null } = {}) {
    const traceId = _uuid();
    const events = [];
    const startedAt = _now();

    events.push({
        id: _uuid(),
        type: 'trace-create',
        timestamp: startedAt,
        body: {
            id: traceId,
            timestamp: startedAt,
            name,
            input,
            metadata,
            tags,
            userId,
            sessionId,
            release: RELEASE || undefined,
            environment: ENVIRONMENT,
        },
    });

    return {
        id: traceId,

        // Record an LLM generation nested in this trace. Returns a handle whose
        // .end() closes it with output/usage (or an error level).
        generation({ name: genName, model, modelParameters = null, input: genInput = null, metadata: genMeta = null } = {}) {
            const genId = _uuid();
            const startTime = _now();
            events.push({
                id: _uuid(),
                type: 'generation-create',
                timestamp: startTime,
                body: {
                    id: genId,
                    traceId,
                    name: genName,
                    model,
                    modelParameters,
                    input: genInput,
                    metadata: genMeta,
                    startTime,
                    environment: ENVIRONMENT,
                },
            });
            return {
                id: genId,
                end({ output = null, usage = null, model: endModel, level, statusMessage, metadata: endMeta } = {}) {
                    events.push({
                        id: _uuid(),
                        type: 'generation-update',
                        timestamp: _now(),
                        body: {
                            id: genId,
                            traceId,
                            endTime: _now(),
                            output,
                            usage,
                            model: endModel,
                            level,
                            statusMessage,
                            metadata: endMeta,
                        },
                    });
                },
            };
        },

        // Update trace-level output / metadata / level (upsert by id).
        update({ output, metadata, level, statusMessage } = {}) {
            events.push({
                id: _uuid(),
                type: 'trace-create',
                timestamp: _now(),
                body: { id: traceId, output, metadata, level, statusMessage },
            });
        },

        // Fire-and-forget flush of everything buffered so far. Safe to await or ignore.
        async flush() { await _send(events.splice(0)); },
    };
}

module.exports = { enabled, trace, usageFromAnthropic };
