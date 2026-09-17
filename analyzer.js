'use strict';
// ── RCA Engine ────────────────────────────────────────────────────────────────

const CLASSIFICATIONS = ['AUTOMATION_SCRIPT_ISSUE','APPLICATION_CODE_ISSUE','DATA_ISSUE','ENVIRONMENT_ISSUE','DEPENDENCY_ISSUE','UNKNOWN'];

const AUTOMATION_PATS = [
  [/IndexOutOfBoundsException/i, 'Automation accessed list element not present in response — check automation index handling'],
  [/upc\s+in\s+\(\d/i, 'UPC values sent without quotes in CQL — known automation bug (upc in (7800000388) → upc in (\'7800000388\'))'],
  [/AssertionError.+expected.+but was/i, 'Assertion failure — automation expected value differs from actual response'],
  [/JsonMappingException.+automation|JsonParseException/i, 'JSON parsing error in automation code'],
  [/NullPointerException.+automation|at com\.safeway\.api\.automation/i, 'NullPointerException in automation code'],
];
const APPLICATION_PATS = [
  [/500 Internal Server Error|InternalServerError/i, 'Application returned HTTP 500 — unhandled server-side error'],
  [/MappingException|MappingError/i, 'Object mapping exception — schema mismatch in application'],
  [/MongoException|BsonException|MongoCommandException/i, 'MongoDB exception in application layer'],
  [/NullPointerException.+at com\.(safeway|albertsons).+(?:service|dao|endpoint|processor)/i, 'NPE in application code path'],
  [/DataAccessException|CassandraException|QueryExecutionException/i, 'Database access error in application'],
];
const ENVIRONMENT_PATS = [
  [/Connection refused|Connection timed out|ECONNREFUSED/i, 'Service unreachable — pod or network issue'],
  [/503 Service Unavailable|502 Bad Gateway/i, 'Gateway error — pod restart or overload'],
  [/WebClientRequestException/i, 'WebClient connection failure — service may be down'],
  [/UnknownHostException/i, 'DNS resolution failure — service endpoint unreachable'],
];
const DEPENDENCY_PATS = [
  [/ConnectException.+(customer-groups|product-groups|offer-service|store-groups)/i, 'Downstream OCOM service connection failure'],
  [/WebClientResponseException\.(BadRequest|NotFound|Forbidden)/i, 'Downstream service returned client error'],
];
const DATA_PATS = [
  [/NoSuchElementException|EmptyResultDataAccessException/i, 'Data not found — test data may be missing'],
  [/duplicate key|DuplicateKeyException/i, 'Duplicate data — test data setup issue'],
  [/404.+not found/i, 'Resource not found — missing data in environment'],
];

function generateRca(failure, module, env, actuator, appTrace, autoTrace, commitAnalysis) {
  let autoScore = 0, appScore = 0, envScore = 0, depScore = 0, dataScore = 0;
  const evidence = [];

  const text = [
    failure.exceptionType, failure.exceptionMessage, failure.stackTrace, failure.rawError,
    actuator?.error || '',
    appTrace?.controller?.content || '',
    autoTrace?.automationStepDef?.content || '',
  ].join('\n');

  for (const [pat, desc] of AUTOMATION_PATS)   { if (pat.test(text)) { autoScore += 2; evidence.push({ source: 'Pattern', detail: desc, weight: 2 }); } }
  for (const [pat, desc] of APPLICATION_PATS)  { if (pat.test(text)) { appScore  += 2; evidence.push({ source: 'Pattern', detail: desc, weight: 2 }); } }
  for (const [pat, desc] of ENVIRONMENT_PATS)  { if (pat.test(text)) { envScore  += 2; evidence.push({ source: 'Pattern', detail: desc, weight: 2 }); } }
  for (const [pat, desc] of DEPENDENCY_PATS)   { if (pat.test(text)) { depScore  += 2; evidence.push({ source: 'Pattern', detail: desc, weight: 2 }); } }
  for (const [pat, desc] of DATA_PATS)         { if (pat.test(text)) { dataScore += 2; evidence.push({ source: 'Pattern', detail: desc, weight: 2 }); } }

  // HTTP status
  if (failure.httpStatus) {
    const s = failure.httpStatus;
    if (s === 400) { appScore++; autoScore++; evidence.push({ source: 'HTTP Status', detail: '400 Bad Request — could be automation wrong payload OR application validation bug' }); }
    else if (s === 404) { dataScore += 2; evidence.push({ source: 'HTTP Status', detail: '404 Not Found — requested resource missing' }); }
    else if (s === 500) { appScore += 3; evidence.push({ source: 'HTTP Status', detail: '500 Internal Server Error — application threw unhandled exception', weight: 3 }); }
    else if (s >= 502 && s <= 503) { envScore += 3; evidence.push({ source: 'HTTP Status', detail: `${s} — gateway error, likely infrastructure issue`, weight: 3 }); }
  }

  // Actuator
  if (actuator?.status === 'ok') {
    evidence.push({ source: 'Actuator', detail: `Deployed: branch=${actuator.branch}, commit=${actuator.commitAbbrev}, version=${actuator.version}` });
  } else if (actuator?.status === 'ACTUATOR_UNAVAILABLE') {
    envScore++;
    evidence.push({ source: 'Actuator', detail: `Actuator unavailable: ${actuator.error} — service may be down` });
  }

  // Correlated commits
  for (const c of (commitAnalysis?.correlated || []).slice(0, 3)) {
    evidence.push({ source: 'Recent Commit', detail: `Potential correlation: ${c.shortSha} — ${c.message} by ${c.author}` });
  }

  // Automation code checks
  const autoContent = autoTrace?.automationStepDef?.content || '';
  if (/upc\s+in\s+\(\d/i.test(autoContent)) {
    autoScore += 3;
    evidence.push({ source: 'Automation Code', detail: 'CQL with unquoted UPC values found in step definition — known automation bug', weight: 3 });
  }

  // Pick winner
  const scores = {
    AUTOMATION_SCRIPT_ISSUE: autoScore,
    APPLICATION_CODE_ISSUE:  appScore,
    ENVIRONMENT_ISSUE:       envScore,
    DEPENDENCY_ISSUE:        depScore,
    DATA_ISSUE:              dataScore,
  };
  let bestCls = 'UNKNOWN', bestScore = 0;
  for (const [cls, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestCls = cls; }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const pct = bestScore / total;
  const confidence = bestScore >= 4 && pct >= 0.6 ? 'HIGH' : bestScore >= 2 && pct >= 0.4 ? 'MEDIUM' : bestScore > 0 ? 'LOW' : 'LOW';

  return {
    classification: bestScore === 0 ? 'UNKNOWN' : bestCls,
    confidence,
    rootCauseSummary: buildSummary(failure, module, env, actuator, bestCls),
    whyItFailed: buildWhy(failure, bestCls, actuator),
    recommendedAction: recommend(bestCls, actuator),
    contributing: evidence.filter(e => (e.weight || 1) >= 2).slice(0, 6).map(e => e.detail),
    evidence,
  };
}

function buildSummary(failure, module, env, actuator, cls) {
  const ep = failure.endpoint ? `${failure.httpMethod} ${failure.endpoint}` : '(unknown)';
  const deploy = actuator?.status === 'ok'
    ? ` [branch=${actuator.branch}, commit=${actuator.commitAbbrev}]`
    : actuator?.status === 'ACTUATOR_UNAVAILABLE' ? ' [actuator unavailable]' : '';
  return `${cls} in ${module} (${env.toUpperCase()})${deploy}. Failed: ${failure.failedStep || ep}. Status: ${failure.httpStatus || 'N/A'}. Exception: ${failure.exceptionType || 'none'}.`;
}

function buildWhy(failure, cls, actuator) {
  const exc = failure.exceptionType || ''; const msg = failure.exceptionMessage || '';
  if (cls === 'AUTOMATION_SCRIPT_ISSUE') {
    if (/IndexOutOfBounds/.test(exc)) return 'The automation code threw IndexOutOfBoundsException accessing a response element that does not exist. The application returned an empty/shorter list than expected. The automation assertion should handle empty responses gracefully.';
    if (/upc\s+in\s+\(\d/i.test(failure.rawError || '')) return "The automation CQL query used unquoted UPC values (upc in (7800000388)) instead of quoted strings (upc in ('7800000388')). Cassandra requires string fields to be quoted. This is a known automation bug.";
    return `Automation generated an incorrect request, assertion, or query. ${msg}`;
  }
  if (cls === 'APPLICATION_CODE_ISSUE') {
    if (failure.httpStatus === 500) return `Application returned HTTP 500. Exception: ${exc}: ${msg}. This indicates an unhandled server-side error.`;
    return `Application behaved incorrectly. Exception: ${exc}: ${msg}.`;
  }
  if (cls === 'ENVIRONMENT_ISSUE') return 'Service was unreachable or returned a gateway error (502/503). Suggests pod restart, scaling event, or network issue in the target environment.';
  if (cls === 'DEPENDENCY_ISSUE') return `A downstream service returned an error that was propagated. Exception: ${exc}: ${msg}.`;
  if (cls === 'DATA_ISSUE') return 'Expected test data was not found or is invalid — possible data migration issue or missing test data setup.';
  return `Insufficient evidence. Exception: ${exc}: ${msg}.`;
}

function recommend(cls, actuator) {
  if (cls === 'AUTOMATION_SCRIPT_ISSUE') return 'Fix the automation script: review the failing step definition, correct the request/assertion/CQL, and re-run.';
  if (cls === 'APPLICATION_CODE_ISSUE') { const b = actuator?.branch || 'deployed branch'; return `Inspect application code on branch '${b}' at the failing endpoint. Review logs and fix the application bug.`; }
  if (cls === 'ENVIRONMENT_ISSUE') return 'Check pod health and restart services if needed. Verify infrastructure (Kafka, Mongo, Cassandra) in the target environment.';
  if (cls === 'DEPENDENCY_ISSUE') return 'Investigate the downstream service actuator and logs. Determine if it is an application or data issue in the dependency.';
  if (cls === 'DATA_ISSUE') return 'Verify test data setup. Run CQL/Mongo verification scripts and ensure migration completed successfully.';
  return 'Gather more evidence: inspect application logs, actuator, and automation request/response for this scenario.';
}

// ── Commit correlation ────────────────────────────────────────────────────────
async function analyzeCommits(module, branch, deployedCommit, endpoint, exceptionType, token) {
  const repoInfo = OCOM_REPOS[module];
  const result = { module, deployedCommit, deployedBranch: branch, recent: [], correlated: [] };
  if (!repoInfo) return result;

  const pathHint = (endpoint || '').split('/').filter(p => p && !p.startsWith('{'))[0]?.toLowerCase() || '';
  const excHint  = (exceptionType || '').toLowerCase();
  const rawCommits = await getRecentCommits(repoInfo.owner, repoInfo.repo, branch || 'master', 20, token);

  for (const raw of rawCommits) {
    const sha = raw.sha || '';
    const detail = raw.commit || {};
    const msg = (detail.message || '').split('\n')[0].substring(0, 200);
    const msgL = msg.toLowerCase();
    const author = detail.author?.name || raw.author?.login || '';
    const date   = detail.author?.date || '';
    let relevance = 'unrelated', reason = '';

    if (pathHint && msgL.includes(pathHint)) { relevance = 'potential_correlation'; reason = `Mentions '${pathHint}'`; }
    else if (excHint && msgL.includes(excHint)) { relevance = 'potential_correlation'; reason = 'Mentions exception type'; }
    else if (/fix|bug|error|revert|hotfix/.test(msgL)) { relevance = 'potential_correlation'; reason = 'Bug-fix or revert commit'; }

    const c = { sha, shortSha: sha.substring(0,8), message: msg, author, date, htmlUrl: raw.html_url || '', relevance, reason };
    result.recent.push(c);
    if (relevance === 'potential_correlation') result.correlated.push(c);
  }
  return result;
}

// ── Code inspection ───────────────────────────────────────────────────────────
async function inspectAppCode(module, commitSha, endpoint, token) {
  const repoInfo = OCOM_REPOS[module];
  const trace = { module, commit: commitSha, controller: null, service: null, dao: null, clients: [] };
  if (!repoInfo || !commitSha) return trace;
  const { owner, repo } = repoInfo;
  const ref = commitSha || 'master';
  const hint = (endpoint || '').split('/').filter(p => p && !p.startsWith('{'))[0]?.toLowerCase() || '';

  try {
    const entries = await getDirListing(owner, repo, 'src/main/java', ref, token);
    const javaFiles = await collectJavaFiles(owner, repo, ref, entries, token, 0);
    for (const fpath of javaFiles) {
      const fname = fpath.toLowerCase();
      if (!trace.controller && /endpoint|controller|resource/.test(fname) && (!hint || fname.includes(hint))) {
        trace.controller = await fetchSnippet(owner, repo, fpath, ref, 'Controller', token);
      } else if (!trace.service && /serviceimpl|service/.test(fname) && !/test/.test(fname) && (!hint || fname.includes(hint))) {
        trace.service = await fetchSnippet(owner, repo, fpath, ref, 'Service', token);
      } else if (!trace.dao && /daoimpl|dao|repository/.test(fname) && (!hint || fname.includes(hint))) {
        trace.dao = await fetchSnippet(owner, repo, fpath, ref, 'DAO', token);
      } else if (trace.clients.length < 2 && /client|connector/.test(fname)) {
        const s = await fetchSnippet(owner, repo, fpath, ref, 'Client', token);
        if (s) trace.clients.push(s);
      }
    }
    // fallback for controller
    if (!trace.controller) {
      for (const fpath of javaFiles) {
        if (/endpoint|controller/.test(fpath.toLowerCase())) {
          trace.controller = await fetchSnippet(owner, repo, fpath, ref, 'Controller', token);
          if (trace.controller) break;
        }
      }
    }
  } catch {}
  return trace;
}

async function inspectAutomationCode(featureFile, scenarioName, token) {
  const owner = 'Albertsons', repo = 'ocom-api-automation', ref = 'master';
  const trace = { module: 'ocom-api-automation', automationFeature: null, automationStepDef: null, automationService: null };

  if (featureFile) {
    const content = await getFileContent(owner, repo, featureFile, ref, token);
    if (content) {
      trace.automationFeature = {
        repo: `${owner}/${repo}`, filePath: featureFile, commitSha: ref,
        content: relevantSection(content, scenarioName, 40),
        githubUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${featureFile}`,
        relevance: 'Failing feature file',
      };
    }
  }

  try {
    const entries = await getDirListing(owner, repo, 'src/test/java', ref, token);
    const javaFiles = await collectJavaFiles(owner, repo, ref, entries, token, 0);
    const kw = (scenarioName || '').match(/\b[A-Za-z]{4,}\b/)?.[0] || '';

    for (const fpath of javaFiles) {
      if (/Steps|StepDef|step/.test(fpath) && !trace.automationStepDef) {
        const c = await getFileContent(owner, repo, fpath, ref, token);
        if (c && kw && c.toLowerCase().includes(kw.toLowerCase())) {
          trace.automationStepDef = { repo: `${owner}/${repo}`, filePath: fpath, commitSha: ref,
            content: relevantSection(c, kw, 30), githubUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${fpath}`, relevance: 'Step definition' };
          break;
        }
      }
    }
    for (const fpath of javaFiles) {
      if (/Service/.test(fpath) && !trace.automationService) {
        const c = await getFileContent(owner, repo, fpath, ref, token);
        if (c && kw && c.toLowerCase().includes(kw.toLowerCase())) {
          trace.automationService = { repo: `${owner}/${repo}`, filePath: fpath, commitSha: ref,
            content: relevantSection(c, kw, 30), githubUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${fpath}`, relevance: 'Service class' };
          break;
        }
      }
    }
  } catch {}
  return trace;
}

async function collectJavaFiles(owner, repo, ref, entries, token, depth) {
  if (depth >= 5) return [];
  const files = [];
  for (const e of entries) {
    if (e.type === 'file' && e.name?.endsWith('.java')) { files.push(e.path); }
    else if (e.type === 'dir') {
      const sub = await getDirListing(owner, repo, e.path, ref, token);
      files.push(...await collectJavaFiles(owner, repo, ref, sub, token, depth + 1));
    }
  }
  return files;
}

async function fetchSnippet(owner, repo, path, ref, layer, token) {
  const content = await getFileContent(owner, repo, path, ref, token);
  if (!content) return null;
  return { repo: `${owner}/${repo}`, filePath: path, className: path.split('/').pop().replace('.java',''),
           commitSha: ref, content: content.substring(0, 3000),
           githubUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`, relevance: layer };
}

function relevantSection(content, keyword, n = 20) {
  if (!keyword || !content) return content.substring(0, 2000);
  const lines = content.split('\n');
  const kl = keyword.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(kl)) {
      return lines.slice(Math.max(0, i-5), Math.min(lines.length, i+n)).join('\n');
    }
  }
  return content.substring(0, 2000);
}
