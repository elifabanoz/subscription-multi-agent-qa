// Persist only bounded metadata and fixed error labels, never raw model output or credentials.
export function executionFailure(provider, execution, fallback = 'CLI_NONZERO_EXIT') {
  const knownSubtypes = new Set(['success', 'error_max_turns', 'error_during_execution',
    'error_max_budget_usd', 'error_max_structured_output_retries']);
  const diagnostic = {
    exitCode: execution.code ?? null,
    exitSignal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(execution.exitSignal) ? execution.exitSignal : null,
    stdoutBytes: Buffer.byteLength(execution.stdout ?? ''),
    stderrBytes: Buffer.byteLength(execution.stderr ?? ''),
    providerResultType: null,
    classificationBasis: 'process_metadata'
  };
  let reason = fallback;
  let reportedErrors = execution.stderr ?? '';
  try {
    if (provider === 'claude') {
      const envelope = JSON.parse(execution.stdout);
      if (knownSubtypes.has(envelope.subtype)) diagnostic.providerResultType = envelope.subtype;
      if (envelope.is_error || envelope.subtype?.startsWith('error_')) {
        const messages = Array.isArray(envelope.errors) ? envelope.errors.filter(x => typeof x === 'string') : [];
        reportedErrors += '\n' + messages.join('\n');
        if (typeof envelope.result === 'string') reportedErrors += '\n' + envelope.result;
      }
    } else {
      for (const line of (execution.stdout ?? '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (['turn.failed', 'error'].includes(event.type)) {
          diagnostic.providerResultType = event.type;
          reportedErrors += '\n' + (typeof event.message === 'string' ? event.message : '');
          reportedErrors += '\n' + (typeof event.error?.message === 'string' ? event.error.message : '');
        }
      }
    }
  } catch { /* Truncated output still has process metadata. */ }
  if (execution.aborted) reason = 'INTERRUPTED';
  else if (execution.timedOut) reason = 'TIMEOUT';
  else if (execution.overflow) reason = 'OUTPUT_LIMIT';
  else if (['CLI_NOT_INSTALLED', 'CLI_START_FAILED'].includes(execution.stderr)) reason = execution.stderr;
  else if (diagnostic.providerResultType === 'error_max_turns') reason = 'CLAUDE_MAX_TURNS';
  else if (diagnostic.providerResultType === 'error_max_budget_usd') reason = 'CLAUDE_BUDGET_LIMIT';
  else if (diagnostic.providerResultType === 'error_max_structured_output_retries') reason = 'CLAUDE_STRUCTURED_OUTPUT_RETRIES';
  else if (/rate.?limit|usage limit|quota exceeded|too many requests|\b429\b|you.?ve hit your limit/i.test(reportedErrors)) {
    reason = 'RATE_OR_USAGE_LIMIT_REPORTED'; diagnostic.classificationBasis = 'error_text_indicator';
  } else if (/authentication failed|failed to authenticate|not logged in|invalid api key|unauthorized|oauth session expired|token (?:has )?expired|\b401\b/i.test(reportedErrors)) {
    reason = 'AUTH_ERROR_REPORTED'; diagnostic.classificationBasis = 'error_text_indicator';
  } else if (/unknown (?:option|argument)|unexpected argument|unrecognized (?:option|argument)/i.test(reportedErrors)) {
    reason = 'CLI_ARGUMENT_ERROR_REPORTED'; diagnostic.classificationBasis = 'error_text_indicator';
  }
  if (reason.startsWith('CLAUDE_')) diagnostic.classificationBasis = 'provider_result_subtype';
  return { state: 'failed', reason, diagnostic };
}
