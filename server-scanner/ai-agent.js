// AI-agent: daily analysis of trade history → structured recommendations.
// Human-in-the-loop: writes proposals to /data/ai-logs/, never edits pending_config
// directly. Apply/Dismiss is triggered from the UI via /api/agent/* endpoints.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pendingConfig = require('./pending_config');
const langfuse = require('./langfuse');

const DATA_ROOT = process.env.AI_AGENT_DATA_ROOT || '/data/ai-logs';
const REC_DIR = path.join(DATA_ROOT, 'recommendations');
const HISTORY_FILE = path.join(DATA_ROOT, 'config-history.jsonl');
const APPLIED_INDEX_FILE = path.join(DATA_ROOT, 'applied-index.jsonl');
const LAST_RUN_FILE = path.join(DATA_ROOT, 'last-run.txt');

const MAX_DIFF_KEYS = 5;
const MAX_RELATIVE_CHANGE = 0.5;
const MAX_BLACKLIST_SIZE_PER_DIFF = 10;

function _ensureDirs() {
    fs.mkdirSync(REC_DIR, { recursive: true });
}

function _log(msg) {
    console.log(`[${new Date().toISOString()}] [ai-agent] ${msg}`);
}

function _moscowHour() {
    const now = new Date();
    const mskMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 3 * 60;
    return Math.floor(((mskMinutes % 1440) + 1440) % 1440 / 60);
}

function _moscowDateStr() {
    const ms = Date.now() + 3 * 60 * 60 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
}

function _shortHash(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

function _writeFileSafe(p, content) {
    fs.writeFileSync(p, content, 'utf-8');
}

function _readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

function _appendJsonl(file, obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
}

// ─── Recommendation file helpers ───

function _listRecommendationFiles() {
    _ensureDirs();
    return fs.readdirSync(REC_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
}

function _readRecommendationFile(filename) {
    const fp = path.join(REC_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (err) {
        _log(`failed to read ${filename}: ${err.message}`);
        return null;
    }
}

function _writeRecommendationFile(filename, data) {
    _writeFileSafe(path.join(REC_DIR, filename), JSON.stringify(data, null, 2));
}

// ─── Data collection ───

async function _collectStats(deps) {
    const { execFetch } = deps;
    const result = { stats: null, analyses: {}, errors: [] };

    const stats = await execFetch('GET', '/stats?days=60');
    if (!stats || !stats.success) {
        result.errors.push(`stats fetch failed: ${stats && stats.error}`);
        return result;
    }
    result.stats = stats;

    // Top-3 best and worst pairs by winrate (requires enough trades)
    const pairs = Object.entries(stats.by_pair || {})
        .filter(([, s]) => s.trades >= 3)
        .map(([sym, s]) => ({ sym, winrate: s.winrate, trades: s.trades }));
    pairs.sort((a, b) => a.winrate - b.winrate);
    const worst = pairs.slice(0, 3);
    const best = pairs.slice(-3).reverse();

    for (const p of [...worst, ...best]) {
        // Convert MT5 symbol back to "EUR/USD" form (5–6 chars assumed standard FX)
        const pair = p.sym.length === 6 ? `${p.sym.slice(0, 3)}/${p.sym.slice(3)}` : p.sym;
        const analysis = await execFetch('GET', `/analysis?pair=${encodeURIComponent(pair)}&days=90`);
        if (analysis && analysis.success) {
            result.analyses[pair] = analysis;
        }
    }
    return result;
}

function _truncate(obj, maxKB = 12) {
    const s = JSON.stringify(obj);
    if (s.length / 1024 <= maxKB) return s;
    // Crude truncation: drop large nested arrays first
    const clone = JSON.parse(s);
    if (clone.stats && clone.stats.overall && clone.stats.overall.equity_curve) {
        delete clone.stats.overall.equity_curve;
    }
    for (const k of Object.keys(clone.analyses || {})) {
        if (clone.analyses[k].deals_stats) {
            delete clone.analyses[k].deals_stats.equity_curve;
        }
        if (Array.isArray(clone.analyses[k].attempts_correlated)) {
            clone.analyses[k].attempts_correlated = clone.analyses[k].attempts_correlated.slice(-10);
        }
    }
    return JSON.stringify(clone);
}

// ─── Claude prompt ───

function _buildSystemPrompt(strategyDoc) {
    const defaults = pendingConfig.defaults();
    const ranges = pendingConfig.ranges();

    const paramLines = Object.entries(defaults).map(([k, v]) => {
        const r = ranges[k];
        if (r) {
            const intMark = r.integer ? ' int' : '';
            return `- ${k} (текущий дефолт: ${JSON.stringify(v)}, диапазон [${r.min}..${r.max}]${intMark})`;
        }
        if (typeof v === 'boolean') return `- ${k} (текущий дефолт: ${v}, тип: boolean)`;
        if (Array.isArray(v)) return `- ${k} (массив, текущий дефолт: ${JSON.stringify(v)})`;
        if (v !== null && typeof v === 'object') return `- ${k} (объект {pair: число}, дефолт: ${JSON.stringify(v)})`;
        return `- ${k} (текущий дефолт: ${JSON.stringify(v)})`;
    }).join('\n');

    return [
        'Ты — оптимизатор торговой стратегии «Слом» по результатам реальной торговли.',
        'Твоя задача: проанализировать переданную статистику и предложить КОНКРЕТНЫЕ изменения параметров.',
        'Ты НЕ применяешь изменения — только формируешь структурированные рекомендации. Человек одобрит вручную.',
        '',
        'Жёсткие правила:',
        '1. ОТВЕТ — ТОЛЬКО ЧИСТЫЙ JSON, без markdown-обёрток, без комментариев. Никакого текста до или после.',
        '2. Каждое предложение должно быть в рамках разрешённых диапазонов параметров (см. ниже).',
        '3. Каждое предложение должно быть подкреплено evidence из переданной статистики.',
        '4. Не предлагай менять параметры если выборка слишком мала (trades < 10) — лучше "недостаточно данных".',
        '5. Максимум 8 предложений в proposals[].',
        '6. Изменение числового параметра не более чем на 50% от текущего значения за один шаг.',
        '7. Если пара плохо работает (winrate <30%, trades>=10) — предлагай добавить её в pair_blacklist.',
        '8. По часам/дням недели предлагай allowed_hours_msk / allowed_weekdays только если разница winrate существенная (>15 п.п.) и samples>=5 в каждой группе.',
        '',
        '=== Полный мануал стратегии ===',
        strategyDoc || '(документ не загружен)',
        '',
        '=== Доступные параметры конфига (pending_config) ===',
        paramLines,
        '',
        '=== Output schema (строго) ===',
        '{',
        '  "summary": "1-2 предложения по-русски",',
        '  "diagnostics": {',
        '    "overall_health": "ok|warning|critical",',
        '    "best_pairs": [{"pair": "EUR/USD", "winrate": 0.55, "trades": 30}],',
        '    "worst_pairs": [{"pair": "GBP/JPY", "winrate": 0.20, "trades": 20}],',
        '    "best_hours_msk": [13, 14],',
        '    "worst_hours_msk": [3, 4],',
        '    "best_weekdays": [1, 2],',
        '    "worst_weekdays": [4]',
        '  },',
        '  "proposals": [',
        '    {',
        '      "kind": "config_change|pair_filter|time_window|hardcoded_extract",',
        '      "rationale": "ru, короткое объяснение",',
        '      "evidence": {"metric":"winrate","before":0.31,"samples":42},',
        '      "confidence": "low|medium|high",',
        '      "diff": {"min_rr": 3.5},',
        '      "expected_impact": "ru, что должно улучшиться"',
        '    }',
        '  ]',
        '}',
    ].join('\n');
}

async function _callClaude(deps, systemText, userText) {
    const { CONFIG, fetchWithTimeout } = deps;
    if (!CONFIG.anthropicApiKey) {
        return { ok: false, error: 'no api key' };
    }
    const payload = {
        model: CONFIG.anthropicModel,
        max_tokens: 2048,
        temperature: 0.2,
        system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userText }],
    };
    const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': CONFIG.anthropicApiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
    }, 90_000);
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { ok: false, error: `HTTP ${r.status}: ${t.slice(0, 400)}` };
    }
    const data = await r.json();
    const text = (data.content || [])
        .filter(b => b && b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
    return { ok: true, text, usage: data.usage || {} };
}

function _parseAndValidateProposals(raw, currentConfig) {
    // Strip code fences if model added them.
    let text = raw.trim();
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
        return { ok: false, error: `not valid JSON: ${err.message}`, raw: text.slice(0, 500) };
    }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'JSON is not an object' };
    }
    parsed.proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    parsed.proposals = parsed.proposals.slice(0, 10);

    const cleanProposals = [];
    const rejected = [];
    for (const p of parsed.proposals) {
        if (!p || typeof p !== 'object' || !p.diff || typeof p.diff !== 'object') {
            rejected.push({ proposal: p, reason: 'missing diff' });
            continue;
        }
        if (Object.keys(p.diff).length === 0) {
            rejected.push({ proposal: p, reason: 'empty diff' });
            continue;
        }
        if (Object.keys(p.diff).length > MAX_DIFF_KEYS) {
            rejected.push({ proposal: p, reason: `too many keys (${Object.keys(p.diff).length} > ${MAX_DIFF_KEYS})` });
            continue;
        }
        const errors = pendingConfig.validate(p.diff);
        if (errors.length > 0) {
            rejected.push({ proposal: p, reason: `validation: ${errors.join('; ')}` });
            continue;
        }
        // Relative change cap on numerics
        let relOk = true;
        for (const [k, v] of Object.entries(p.diff)) {
            if (typeof v === 'number' && typeof currentConfig[k] === 'number' && currentConfig[k] !== 0) {
                const rel = Math.abs(v - currentConfig[k]) / Math.abs(currentConfig[k]);
                if (rel > MAX_RELATIVE_CHANGE) {
                    rejected.push({ proposal: p, reason: `change too large: ${k} ${currentConfig[k]}→${v} (${(rel*100).toFixed(0)}%)` });
                    relOk = false;
                    break;
                }
            }
        }
        if (!relOk) continue;
        if (p.diff.pair_blacklist && p.diff.pair_blacklist.length > MAX_BLACKLIST_SIZE_PER_DIFF) {
            rejected.push({ proposal: p, reason: `pair_blacklist too large (>${MAX_BLACKLIST_SIZE_PER_DIFF})` });
            continue;
        }
        // Hard-stop guards on min_rr
        if (p.diff.min_rr !== undefined && (p.diff.min_rr < 1.5 || p.diff.min_rr > 6)) {
            rejected.push({ proposal: p, reason: 'min_rr outside safe range [1.5..6]' });
            continue;
        }
        cleanProposals.push({
            id: `p-${crypto.randomBytes(4).toString('hex')}`,
            kind: p.kind || 'config_change',
            rationale: String(p.rationale || ''),
            evidence: p.evidence || null,
            confidence: ['low', 'medium', 'high'].includes(p.confidence) ? p.confidence : 'medium',
            diff: p.diff,
            expected_impact: String(p.expected_impact || ''),
            status: 'pending',
        });
    }
    return {
        ok: true,
        summary: String(parsed.summary || ''),
        diagnostics: parsed.diagnostics || {},
        proposals: cleanProposals,
        rejected,
    };
}

function _formatDigest(report, domain) {
    const lines = [];
    lines.push(`🤖 *AI-агент стратегии — дайджест*`);
    lines.push(`_${report.generated_at.replace('T', ' ').slice(0, 16)} UTC_`);
    lines.push('');
    const o = report.stats_snapshot && report.stats_snapshot.overall;
    if (o) {
        lines.push(`📊 За ${report.period_days || 60} дней: winrate \`${(o.winrate*100).toFixed(0)}%\`, PF \`${o.profit_factor}\`, DD \`${o.max_drawdown}\``);
    }
    const d = report.diagnostics || {};
    if (Array.isArray(d.best_pairs) && d.best_pairs.length) {
        lines.push(`🏆 Лучшие: ${d.best_pairs.map(x => `${x.pair} ${(x.winrate*100).toFixed(0)}%`).join(', ')}`);
    }
    if (Array.isArray(d.worst_pairs) && d.worst_pairs.length) {
        lines.push(`⚠ Худшие: ${d.worst_pairs.map(x => `${x.pair} ${(x.winrate*100).toFixed(0)}%`).join(', ')}`);
    }
    lines.push('');
    lines.push(`💡 *Новые предложения: ${report.proposals.length}*`);
    report.proposals.slice(0, 5).forEach((p, i) => {
        const conf = p.confidence.toUpperCase();
        lines.push(`${i+1}. [${conf}] ${p.rationale}`);
    });
    if (domain) {
        lines.push('');
        lines.push(`👉 https://${domain}/ai-agent.html`);
    }
    return lines.join('\n');
}

// ─── Public API ───

async function runAnalysis(deps, { silent = false } = {}) {
    _ensureDirs();
    const { execFetch, sendTelegram, CONFIG, fetchWithTimeout, strategyDoc } = deps;

    if (!CONFIG.anthropicApiKey) {
        _log('skipping: ANTHROPIC_API_KEY not set');
        return { ok: false, error: 'no api key' };
    }
    if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
        _log('skipping: executor not configured');
        return { ok: false, error: 'no executor' };
    }

    _log('starting analysis run...');
    const collected = await _collectStats(deps);
    if (!collected.stats) {
        _log(`failed to collect stats: ${collected.errors.join('; ')}`);
        return { ok: false, error: 'stats unavailable', details: collected.errors };
    }

    const currentConfig = pendingConfig.get(true);
    const recentRecs = _listRecommendationFiles().slice(0, 5).map(_readRecommendationFile).filter(Boolean);
    const recentHistory = _readJsonl(HISTORY_FILE).slice(-30);

    const userPayload = {
        stats: collected.stats,
        per_pair_analyses: collected.analyses,
        current_config: currentConfig,
        recent_recommendations: recentRecs.map(r => ({
            generated_at: r.generated_at,
            summary: r.summary,
            proposals: (r.proposals || []).map(p => ({
                kind: p.kind, rationale: p.rationale, status: p.status, diff: p.diff,
            })),
        })),
        recent_config_history: recentHistory,
    };
    const userText = _truncate(userPayload, 12);

    const systemText = _buildSystemPrompt(strategyDoc);

    // Langfuse trace (no-op unless LANGFUSE_* env is set).
    const lfTrace = langfuse.enabled() ? langfuse.trace({
        name: 'ai-agent.daily-analysis',
        input: {
            overall: collected.stats.overall,
            pairs_analyzed: Object.keys(collected.analyses),
            period_days: 60,
        },
        metadata: { source: 'scheduler-or-manual', model: CONFIG.anthropicModel },
        tags: ['scanner', 'ai-agent'],
    }) : null;
    const lfGen = lfTrace ? lfTrace.generation({
        name: 'strategy-optimizer',
        model: CONFIG.anthropicModel,
        modelParameters: { max_tokens: 2048, temperature: 0.2 },
        input: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
    }) : null;

    const claude = await _callClaude({ CONFIG, fetchWithTimeout }, systemText, userText);
    if (!claude.ok) {
        _log(`Claude error: ${claude.error}`);
        if (lfGen) lfGen.end({ level: 'ERROR', statusMessage: claude.error });
        if (lfTrace) { lfTrace.update({ level: 'ERROR', statusMessage: claude.error }); await lfTrace.flush(); }
        return { ok: false, error: claude.error };
    }
    _log(`Claude usage: in=${claude.usage.input_tokens} out=${claude.usage.output_tokens} cache_read=${claude.usage.cache_read_input_tokens || 0} cache_create=${claude.usage.cache_creation_input_tokens || 0}`);
    if (lfGen) lfGen.end({ output: claude.text, usage: langfuse.usageFromAnthropic(claude.usage) });

    const parsed = _parseAndValidateProposals(claude.text, currentConfig);
    if (!parsed.ok) {
        _log(`parse failed: ${parsed.error}`);
        if (lfTrace) { lfTrace.update({ level: 'WARNING', statusMessage: `parse failed: ${parsed.error}` }); await lfTrace.flush(); }
        return { ok: false, error: parsed.error, raw: parsed.raw };
    }

    const now = new Date();
    const filename = `${_moscowDateStr()}-${crypto.randomBytes(3).toString('hex')}.json`;
    const report = {
        id: filename.replace('.json', ''),
        generated_at: now.toISOString(),
        period_days: 60,
        summary: parsed.summary,
        diagnostics: parsed.diagnostics,
        proposals: parsed.proposals,
        rejected_count: parsed.rejected.length,
        rejected_reasons: parsed.rejected.slice(0, 5).map(r => r.reason),
        stats_snapshot: {
            overall: collected.stats.overall,
            by_pair_count: Object.keys(collected.stats.by_pair || {}).length,
        },
        config_at_run: currentConfig,
        usage: claude.usage,
    };
    _writeRecommendationFile(filename, report);
    _writeFileSafe(LAST_RUN_FILE, _moscowDateStr());

    if (!silent && sendTelegram) {
        try {
            await sendTelegram(_formatDigest(report, CONFIG.domain));
        } catch (err) {
            _log(`telegram send error: ${err.message}`);
        }
    }
    if (lfTrace) {
        lfTrace.update({
            output: {
                report_id: report.id,
                summary: parsed.summary,
                proposals: parsed.proposals.length,
                rejected: parsed.rejected.length,
                overall_health: (parsed.diagnostics || {}).overall_health,
            },
        });
        await lfTrace.flush();
    }
    _log(`done: ${parsed.proposals.length} proposals (${parsed.rejected.length} rejected) saved to ${filename}`);
    return { ok: true, report_id: report.id, proposals: parsed.proposals.length };
}

function getRecommendations({ status = null, limit = 50 } = {}) {
    _ensureDirs();
    const files = _listRecommendationFiles().slice(0, limit);
    const reports = files.map(_readRecommendationFile).filter(Boolean);
    if (status) {
        // Filter individual proposals by status
        return reports.map(r => ({
            ...r,
            proposals: (r.proposals || []).filter(p => p.status === status),
        })).filter(r => r.proposals.length > 0);
    }
    return reports;
}

function getRecommendation(id) {
    _ensureDirs();
    const filename = id.endsWith('.json') ? id : `${id}.json`;
    return _readRecommendationFile(filename);
}

function _findProposal(recommendationId, proposalId) {
    const filename = recommendationId.endsWith('.json') ? recommendationId : `${recommendationId}.json`;
    const rec = _readRecommendationFile(filename);
    if (!rec) return { error: 'recommendation not found' };
    const prop = (rec.proposals || []).find(p => p.id === proposalId);
    if (!prop) return { error: 'proposal not found' };
    return { rec, prop, filename };
}

function applyRecommendation(recommendationId, proposalId, userEmail) {
    const { rec, prop, filename, error } = _findProposal(recommendationId, proposalId);
    if (error) return { ok: false, error };
    if (prop.status !== 'pending') return { ok: false, error: `proposal already ${prop.status}` };

    // Re-validate at apply time (defence-in-depth)
    const errors = pendingConfig.validate(prop.diff);
    if (errors.length > 0) return { ok: false, error: `validation failed: ${errors.join('; ')}` };

    const before = pendingConfig.get(true);
    const r = pendingConfig.update(prop.diff);
    if (!r.success) return { ok: false, error: r.errors ? r.errors.join('; ') : 'update failed' };
    const after = r.config;

    prop.status = 'applied';
    prop.applied_at = new Date().toISOString();
    prop.applied_by = userEmail || 'unknown';
    _writeRecommendationFile(filename, rec);

    const historyEntry = {
        timestamp: new Date().toISOString(),
        source: 'agent',
        recommendation_id: rec.id,
        proposal_id: proposalId,
        before, after,
        diff: prop.diff,
        user_email: userEmail || 'unknown',
        diff_hash: _shortHash(prop.diff),
    };
    _appendJsonl(HISTORY_FILE, historyEntry);
    _appendJsonl(APPLIED_INDEX_FILE, {
        proposal_id: proposalId,
        recommendation_id: rec.id,
        applied_at: historyEntry.timestamp,
        diff: prop.diff,
        metrics_before: null,
        metrics_after_7d: null,
        metrics_after_30d: null,
    });
    return { ok: true, before, after, diff: prop.diff };
}

function dismissRecommendation(recommendationId, proposalId, reason, userEmail) {
    const { rec, prop, filename, error } = _findProposal(recommendationId, proposalId);
    if (error) return { ok: false, error };
    if (prop.status !== 'pending') return { ok: false, error: `proposal already ${prop.status}` };
    prop.status = 'dismissed';
    prop.dismissed_at = new Date().toISOString();
    prop.dismissed_by = userEmail || 'unknown';
    prop.dismiss_reason = String(reason || '').slice(0, 500);
    _writeRecommendationFile(filename, rec);
    return { ok: true };
}

async function getHistory(deps) {
    _ensureDirs();
    const history = _readJsonl(HISTORY_FILE);
    const applied = _readJsonl(APPLIED_INDEX_FILE);

    // Lazily fill metrics_after_Nd if applied_at is old enough.
    const { execFetch } = deps || {};
    if (execFetch) {
        const now = Date.now();
        for (const row of applied) {
            const ts = Date.parse(row.applied_at);
            if (!ts) continue;
            const ageDays = (now - ts) / 86_400_000;
            if (ageDays >= 7 && !row.metrics_after_7d) {
                const r = await execFetch('GET', `/stats?days=7&from_ts=${Math.floor(ts/1000)}`).catch(() => null);
                if (r && r.success) row.metrics_after_7d = r.overall;
            }
            if (ageDays >= 30 && !row.metrics_after_30d) {
                const r = await execFetch('GET', `/stats?days=30&from_ts=${Math.floor(ts/1000)}`).catch(() => null);
                if (r && r.success) row.metrics_after_30d = r.overall;
            }
        }
        // Persist back if anything changed
        try {
            fs.writeFileSync(APPLIED_INDEX_FILE,
                applied.map(r => JSON.stringify(r)).join('\n') + (applied.length ? '\n' : ''),
                'utf-8');
        } catch (err) {
            _log(`failed to persist applied-index: ${err.message}`);
        }
    }
    return { history, applied };
}

let _schedulerTimer = null;
let _isRunning = false;

function startDailyScheduler(deps) {
    if (_schedulerTimer) clearInterval(_schedulerTimer);
    const targetHour = parseInt(process.env.AI_AGENT_CRON_MSK_HOUR || '3', 10);
    _log(`scheduler started, will run daily at ${targetHour}:00 MSK`);

    const tick = async () => {
        if (_isRunning) return;
        try {
            const hour = _moscowHour();
            if (hour !== targetHour) return;
            const today = _moscowDateStr();
            const last = fs.existsSync(LAST_RUN_FILE)
                ? fs.readFileSync(LAST_RUN_FILE, 'utf-8').trim()
                : '';
            if (last === today) return;
            _isRunning = true;
            await runAnalysis(deps);
        } catch (err) {
            _log(`scheduler tick error: ${err.message}`);
        } finally {
            _isRunning = false;
        }
    };

    _schedulerTimer = setInterval(tick, 5 * 60 * 1000);
    // Fire one check immediately so manual restarts don't miss the window.
    setTimeout(tick, 5_000);
}

function isRunning() { return _isRunning; }

async function manualRun(deps) {
    if (_isRunning) return { ok: false, error: 'already running' };
    _isRunning = true;
    try {
        return await runAnalysis(deps);
    } finally {
        _isRunning = false;
    }
}

module.exports = {
    runAnalysis,
    manualRun,
    getRecommendations,
    getRecommendation,
    applyRecommendation,
    dismissRecommendation,
    getHistory,
    startDailyScheduler,
    isRunning,
    _formatDigest,    // exported for tests
};
