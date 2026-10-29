import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const name = 'gitee-enterprise';
export const inject = ['webServer', 'connection'];

const PREFIX = '/gitee-enterprise';
const V5 = 'https://gitee.com/api/v5';
const V8 = 'https://api.gitee.com/enterprises';
const REQUEST_TIMEOUT = 25_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const META_CACHE_TTL = 5 * 60_000;
const PROGRAM_CACHE_TTL = 30 * 60_000;
const ISSUES_CACHE_TTL = 2 * 60_000;
const DETAIL_CACHE_TTL = 60_000;

const responseCache = new Map();

function cacheKey(state, kind, extra = '') {
  const tenant = state?.enterprise?.id || state?.enterprise?.path || 'none';
  return `${state?.tokenType || 'none'}:${tenant}:${kind}:${extra}`;
}

async function cached(key, ttl, loader, refresh = false) {
  if (!refresh) {
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
  }
  const value = await loader();
  responseCache.set(key, { at: Date.now(), value });
  return value;
}

function clearResponseCache() {
  responseCache.clear();
}

class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class GiteeError extends AppError {
  constructor(message, status = 502, details) {
    super('gitee_error', message, status, details);
    this.name = 'GiteeError';
  }
}

function asAppError(error) {
  if (error instanceof AppError) return error;
  const message = error?.name === 'TimeoutError'
    ? '请求 Gitee 超时，请检查网络后重试。'
    : (error?.message || String(error || '未知错误'));
  return new AppError('internal_error', message, 500);
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendOk(res, value, status = 200) {
  sendJson(res, status, { ok: true, value });
}

function sendError(res, error) {
  const appError = asAppError(error);
  if (!res.headersSent) {
    sendJson(res, appError.status, {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    });
  }
}

async function readJson(req, limit = 1024 * 1024) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError('unsupported_media_type', 'Content-Type 必须是 application/json', 415);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new AppError('payload_too_large', '请求体过大', 413);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('invalid_json', '请求体不是合法 JSON', 400);
  }
}

function resolveProfileDirectory() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = path.join(home, 'profiles');
  for (const arg of process.argv.slice(1)) {
    if (typeof arg !== 'string' || !arg) continue;
    let resolved;
    try {
      resolved = path.resolve(arg);
    } catch {
      continue;
    }
    if (resolved !== profiles && !resolved.startsWith(`${profiles}${path.sep}`)) continue;
    const relative = path.relative(profiles, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const profileDir = path.join(profiles, relative.split(path.sep)[0]);
    if (existsSync(path.join(profileDir, 'package.json'))) return profileDir;
  }
  if (process.env.DSH_PROFILE) return path.join(profiles, process.env.DSH_PROFILE);
  return path.join(profiles, 'default');
}

function cleanText(value, limit = 4096) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? value.slice(0, limit) : value;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function encodeQuery(pathname, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

async function giteeRequest(url, options = {}) {
  return (await giteeRequestResponse(url, options)).payload;
}

async function giteeRequestResponse(url, { method = 'GET', accessToken, form, json } = {}) {
  const target = new URL(url);
  if (accessToken) target.searchParams.set('access_token', accessToken);
  const headers = {
    accept: 'application/json',
    'user-agent': 'mcp-gitee-ent/1.0.0',
  };
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers['content-type'] = 'application/json';
  } else if (form) {
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw error;
    throw new GiteeError(`无法连接 Gitee：${error?.message || error}`, 502);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload
      ? (payload.message || payload.error || `Gitee 返回 HTTP ${response.status}`)
      : (String(payload || '').slice(0, 200) || `Gitee 返回 HTTP ${response.status}`);
    throw new GiteeError(message, response.status >= 500 ? 502 : response.status, payload);
  }
  if (typeof payload === 'object' && payload && payload.message && !Array.isArray(payload)) {
    throw new GiteeError(String(payload.message), 502, payload);
  }
  return { payload, headers: response.headers };
}

async function v5User(token) {
  return giteeRequest(`${V5}/user`, { accessToken: token });
}

async function v5Enterprises(token) {
  const data = await giteeRequest(`${V5}/user/enterprises`, {
    accessToken: token,
    form: undefined,
  });
  return Array.isArray(data) ? data : [];
}

async function v8Programs(token, enterpriseId, perPage = 1) {
  return giteeRequest(
    `${V8}/${encodeURIComponent(enterpriseId)}/programs${encodeQuery('', { per_page: perPage, page: 1 })}`,
    { accessToken: token },
  );
}

async function v8Enterprise(token, enterpriseId) {
  return giteeRequest(`${V8}/${encodeURIComponent(enterpriseId)}`, { accessToken: token });
}

function v8Items(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function v8Total(payload) {
  const value = Number(payload?.total_count);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function mapTypeFromText(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('需求') || value === 'requirement') return 'requirement';
  if (value.includes('缺陷') || value.includes('bug') || value.includes('故障')) return 'bug';
  if (value.includes('任务') || value === 'task') return 'task';
  return 'task';
}

function normalizeType(issue) {
  const ident = issue?.issue_type_detail?.ident || issue?.issue_type?.ident;
  if (ident) return ident;
  return mapTypeFromText(issue?.issue_type_detail?.title || issue?.issue_type?.title || issue?.issue_type);
}

function stateText(value) {
  const map = { open: '开启', progressing: '进行中', closed: '已关闭', rejected: '已拒绝' };
  return map[value] || value || '—';
}

function parentNumberFromUrl(value) {
  const match = /\/issues\/([^/?#]+)/u.exec(String(value || ''));
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeIssue(issue, { enterprise, programsById } = {}) {
  const programId = Number(issue?.program?.id ?? issue?.program_id ?? 0) || 0;
  const program = issue?.program || programsById?.get(programId) || null;
  const typeIdent = normalizeType(issue);
  const state = issue?.state || (issue?.issue_state?.command ? String(issue.issue_state.command) : 'open');
  const parentId = Number(issue?.parent_id ?? issue?.parent?.id ?? 0) || 0;
  const parentNumber = cleanText(
    issue?.parent_ident || issue?.parent?.ident || issue?.parent?.number || parentNumberFromUrl(issue?.parent_url),
    100,
  );
  const depth = Number(issue?.depth ?? (parentId ? 1 : 0)) || 0;
  return {
    id: issue?.id ?? null,
    number: String(issue?.number || issue?.ident || ''),
    title: issue?.title || '(无标题)',
    type: typeIdent,
    typeLabel: issue?.issue_type_detail?.title || issue?.issue_type?.title || issue?.issue_type || stateText(typeIdent),
    state,
    stateLabel: issue?.issue_state_detail?.title || issue?.issue_state?.title || issue?.issue_state || stateText(state),
    priority: Number(issue?.priority ?? 0) || 0,
    priorityLabel: issue?.priority_human || '',
    assignee: issue?.assignee ? {
      id: issue.assignee.id,
      login: cleanText(issue.assignee.login || issue.assignee.username, 100),
      name: cleanText(issue.assignee.name || issue.assignee.remark || issue.assignee.login || issue.assignee.username, 200),
    } : null,
    collaborators: (Array.isArray(issue?.collaborators) ? issue.collaborators : (Array.isArray(issue?.collaborator) ? issue.collaborator : []))
      .map((item) => ({
        id: Number(item?.id || item?.user?.id) || 0,
        login: cleanText(item?.login || item?.username || item?.user?.login, 100),
        name: cleanText(item?.name || item?.remark || item?.user?.name || item?.login || item?.username || item?.user?.login, 200),
      }))
      .filter((item) => item.login),
    author: issue?.user ? {
      id: issue.user.id,
      login: issue.user.login,
      name: issue.user.name || issue.user.login,
    } : (issue?.author ? {
      id: issue.author.id,
      login: issue.author.username || issue.author.login,
      name: issue.author.name || issue.author.username || issue.author.login,
    } : null),
    programId,
    programName: program?.name || issue?.program_name || '未归属项目',
    parentId,
    parentNumber,
    parentTitle: cleanText(issue?.parent?.title, 500),
    depth,
    parentHtmlUrl: parentNumber && enterprise?.path
      ? `https://gitee.com/${enterprise.path}/dashboard?issue_id=${encodeURIComponent(parentNumber)}`
      : '',
    createdAt: issue?.created_at || null,
    updatedAt: issue?.updated_at || null,
    planStartedAt: issue?.plan_started_at || null,
    deadline: issue?.deadline || null,
    finishedAt: issue?.finished_at || null,
    actualStartedAt: (() => {
      if (issue?.started_at) return issue.started_at;
      const raw = Number(issue?.scheduled_time) || 0;
      if (!raw) return null;
      const ms = raw > 1e12 ? raw : raw * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    })(),
    htmlUrl: issue?.html_url || (enterprise?.path && issue?.ident
      ? `https://gitee.com/${enterprise.path}/dashboard?issue_id=${encodeURIComponent(issue.ident)}`
      : ''),
    body: issue?.body || issue?.description || '',
    commentsCount: Number(issue?.comments_count ?? 0) || 0,
    issueStateId: issue?.issue_state_id ?? issue?.issue_state?.id ?? null,
    issueTypeId: issue?.issue_type_id ?? issue?.issue_type?.id ?? null,
  };
}

function matchesFilters(issue, { type, programId, search, assignee, state }) {
  if (state && state !== 'all' && issue.state !== state) return false;
  if (type && type !== 'all' && issue.type !== type) return false;
  if (programId && Number(programId) !== 0 && issue.programId !== Number(programId)) return false;
  if (assignee && String(issue.assignee?.login || '') !== String(assignee)) return false;
  if (search) {
    const terms = String(search).toLowerCase().split(/\s+/u).filter(Boolean);
    const haystack = `${issue.title || ''} ${issue.number || ''} ${issue.assignee?.name || ''} ${issue.assignee?.login || ''}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

function matchesWorkItemFilter(issue, filter) {
  if (!filter?.enabled || !filter.person) return true;
  const wanted = String(filter.person).toLowerCase();
  const isAssignee = String(issue.assignee?.login || '').toLowerCase() === wanted;
  const isCollaborator = (issue.collaborators || []).some((item) => String(item.login || '').toLowerCase() === wanted);
  switch (filter.scope) {
    case 'assignee': return isAssignee;
    case 'collaborator': return isCollaborator;
    default: return isAssignee || isCollaborator;
  }
}

class StateStore {
  constructor(directory, logger) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.logger = logger;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let raw = null;
    if (existsSync(this.file)) {
      try {
        raw = JSON.parse(await readFile(this.file, 'utf8'));
      } catch (error) {
        this.logger?.warn?.(`gitee-enterprise: state.json unreadable, starting empty: ${error.message}`);
      }
    }
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const enterprise = state.enterprise && typeof state.enterprise === 'object' ? state.enterprise : null;
    const filter = state.workItemFilter && typeof state.workItemFilter === 'object' ? state.workItemFilter : {};
    const filterScope = ['either', 'assignee', 'collaborator'].includes(filter.scope) ? filter.scope : 'either';
    this.state = {
      version: 1,
      token: typeof state.token === 'string' ? state.token : '',
      tokenType: state.tokenType === 'enterprise' ? 'enterprise' : (state.tokenType === 'private' ? 'private' : ''),
      account: state.account && typeof state.account === 'object' ? state.account : null,
      enterprise: enterprise ? {
        id: Number(enterprise.id) || 0,
        path: cleanText(enterprise.path, 200),
        name: cleanText(enterprise.name, 200),
      } : null,
      workItemFilter: {
        enabled: filter.enabled === true,
        person: cleanText(filter.person, 100),
        personName: cleanText(filter.personName, 200),
        scope: filterScope,
      },
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
    };
    if (!existsSync(this.file)) await this.persist();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async persist() {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      await chmod(temp, 0o600);
    } catch {
      // Windows does not use POSIX bits; the profile directory ACL still applies.
    }
    await rename(temp, this.file);
  }

  update(patch) {
    const run = this.queue.then(async () => {
      this.state = {
        ...this.state,
        ...patch,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      await this.persist();
      return this.snapshot();
    });
    this.queue = run.catch((error) => {
      this.logger?.warn?.(`gitee-enterprise: state update failed: ${error?.message || error}`);
    });
    return run;
  }

  clear() {
    return this.update({
      token: '',
      tokenType: '',
      account: null,
      enterprise: null,
      workItemFilter: { enabled: false, person: '', personName: '', scope: 'either' },
    });
  }
}

function publicState(state) {
  const configured = Boolean(state.token && state.tokenType && state.enterprise);
  const full = state.tokenType === 'enterprise';
  return {
    configured,
    tokenType: state.tokenType || '',
    tokenMasked: maskToken(state.token),
    account: state.account,
    enterprise: state.enterprise,
    workItemFilter: state.workItemFilter,
    capabilities: {
      read: configured,
      update: configured,
      create: full,
      delete: full,
      selfTest: full,
    },
    updatedAt: state.updatedAt,
  };
}

async function chooseEnterprise(token, requested) {
  const list = await v5Enterprises(token);
  const enterprises = list.map((item) => ({
    id: Number(item.id) || 0,
    path: cleanText(item.path, 200),
    name: cleanText(item.name || item.path, 200),
    url: cleanText(item.url, 500),
    avatarUrl: cleanText(item.avatar_url, 500),
  }));
  if (!enterprises.length) {
    throw new AppError('no_enterprise', '该令牌没有可见的 Gitee 企业。', 400);
  }
  const needle = String(requested || '').trim().toLowerCase();
  let enterprise = null;
  if (needle) {
    enterprise = enterprises.find((item) =>
      String(item.id) === needle
      || item.path.toLowerCase() === needle
      || item.name.toLowerCase() === needle,
    ) || null;
    if (!enterprise) {
      throw new AppError('enterprise_not_found', `令牌下找不到企业：${requested}`, 404);
    }
  } else {
    enterprise = enterprises[0];
  }
  return { enterprises, enterprise };
}

async function detectToken(token, requestedEnterprise) {
  let user = null;
  try {
    user = await v5User(token);
  } catch {
    user = null;
  }

  if (user) {
    const account = {
      id: Number(user.id) || 0,
      login: cleanText(user.login, 200),
      name: cleanText(user.name || user.login, 200),
      avatarUrl: cleanText(user.avatar_url, 500),
    };
    const { enterprises, enterprise } = await chooseEnterprise(token, requestedEnterprise);
    let enterpriseApi = false;
    try {
      await v8Programs(token, enterprise.id, 1);
      enterpriseApi = true;
    } catch {
      enterpriseApi = false;
    }
    return {
      tokenType: enterpriseApi ? 'enterprise' : 'private',
      account,
      enterprise,
      enterprises,
    };
  }

  const id = String(requestedEnterprise || '').trim();
  if (!id || !/^\d+$/.test(id)) {
    throw new AppError(
      'enterprise_id_required',
      '该令牌不是私人令牌。使用企业 MCP 令牌时，请填写企业的数字 ID。',
      400,
    );
  }
  try {
    await v8Programs(token, id, 1);
  } catch (error) {
    if (error instanceof AppError && error.status >= 400 && error.status < 500) {
      const message = String(error.message || '');
      if (/only for mcp gitee enterprise application/iu.test(message)) {
        throw new AppError(
          'enterprise_token_required',
          '该令牌不是企业版 MCP 令牌。请到 Gitee「设置 → 私人令牌 → 企业 MCP 令牌」重新生成，并填写企业的数字 ID。',
          401,
        );
      }
      throw new AppError('invalid_token', '令牌无效，或没有该企业的访问权限。', 401);
    }
    throw error;
  }
  let enterpriseInfo = null;
  try {
    enterpriseInfo = await v8Enterprise(token, id);
  } catch {
    enterpriseInfo = null;
  }
  const enterprise = {
    id: Number(id),
    path: cleanText(enterpriseInfo?.path, 200),
    name: cleanText(enterpriseInfo?.name, 200) || `企业 ${id}`,
  };
  return {
    tokenType: 'enterprise',
    account: null,
    enterprise,
    enterprises: [enterprise],
  };
}

function totalPagesFromLink(link) {
  for (const part of String(link || '').split(',')) {
    if (!/rel=["']?last["']?/iu.test(part)) continue;
    const match = /[?&]page=(\d+)/u.exec(part);
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

async function listV5IssuePage(state, filters, page, perPage) {
  const e = state.enterprise;
  const query = {
    state: filters.state || 'all',
    page,
    per_page: perPage,
  };
  if (filters.search) query.search = filters.search;
  if (filters.assignee) query.assignee = filters.assignee;
  if (filters.sort === 'created' || filters.sort === 'updated') {
    query.sort = filters.sort;
    query.direction = filters.direction === 'asc' ? 'asc' : 'desc';
  }
  const result = await giteeRequestResponse(
    `${V5}/enterprises/${encodeURIComponent(e.path)}/issues${encodeQuery('', query)}`,
    { accessToken: state.token },
  );
  const items = Array.isArray(result.payload) ? result.payload : [];
  const totalPages = totalPagesFromLink(result.headers.get('link'));
  return {
    items,
    totalPages,
    hasMore: totalPages > 0 ? page < totalPages : items.length >= perPage,
  };
}

async function v8IssueTypes(state) {
  const data = await giteeRequest(
    `${V8}/${state.enterprise.id}/issue_types${encodeQuery('', { per_page: 100, page: 1 })}`,
    { accessToken: state.token },
  );
  return v8Items(data);
}

async function v8IssueStates(state) {
  const data = await giteeRequest(
    `${V8}/${state.enterprise.id}/issue_states${encodeQuery('', { per_page: 100, page: 1 })}`,
    { accessToken: state.token },
  );
  return v8Items(data);
}

function normalizeProgram(item) {
  return {
    id: Number(item?.id) || 0,
    ident: cleanText(item?.ident, 100),
    name: cleanText(item?.name || `项目 ${item?.id || ''}`, 300),
    status: item?.status ?? null,
    category: cleanText(item?.category, 100),
    issuesCount: Number(item?.issues_count) || 0,
    closedIssuesCount: Number(item?.closed_issues_count) || 0,
    color: cleanText(item?.color, 50),
  };
}

async function loadPrograms(state) {
  return cached(cacheKey(state, 'programs'), PROGRAM_CACHE_TTL, () => loadProgramsUncached(state));
}

async function loadProgramsUncached(state) {
  if (state.tokenType === 'enterprise') {
    const map = new Map();
    const maxPages = 50;
    const perPage = 100;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await giteeRequestResponse(
        `${V8}/${state.enterprise.id}/programs${encodeQuery('', { per_page: perPage, page, sort: 'updated_at', direction: 'desc' })}`,
        { accessToken: state.token },
      );
      const items = v8Items(result.payload);
      for (const item of items) {
        const program = normalizeProgram(item);
        if (program.id && !map.has(program.id)) map.set(program.id, program);
      }
      const total = v8Total(result.payload);
      const totalPages = total > 0 ? Math.ceil(total / perPage) : totalPagesFromLink(result.headers.get('link'));
      if (totalPages > 0 ? page >= totalPages : items.length < perPage) break;
    }
    return [...map.values()];
  }

  // A private token cannot list enterprise programs directly (v5 has no
  // /programs endpoint), so discover them from the work-item stream instead
  // of only looking at the first page of open issues.
  const perPage = 100;
  const maxPages = 50;
  const first = await listV5IssuePage(state, { state: 'all' }, 1, perPage);
  const pages = [first];
  const totalPages = Math.min(first.totalPages || (first.hasMore ? maxPages : 1), maxPages);
  if (totalPages > 1) {
    let nextPage = 2;
    const worker = async () => {
      while (nextPage <= totalPages) {
        const page = nextPage;
        nextPage += 1;
        try {
          pages.push(await listV5IssuePage(state, { state: 'all' }, page, perPage));
        } catch {
          // Keep the programs discovered so far if one page fails.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, totalPages - 1) }, worker));
  }

  const map = new Map();
  for (const page of pages) {
    for (const issue of page.items) {
      const program = issue?.program;
      if (!program || !program.id) continue;
      if (!map.has(program.id)) {
        map.set(program.id, {
          id: Number(program.id) || 0,
          ident: '',
          name: cleanText(program.name || `项目 ${program.id}`, 300),
          status: program.status ?? null,
          category: '',
          issuesCount: 0,
          closedIssuesCount: 0,
          color: '',
        });
      }
      map.get(program.id).issuesCount += 1;
      if (issue.state === 'closed' || issue.state === 'rejected') {
        map.get(program.id).closedIssuesCount += 1;
      }
    }
  }
  return [...map.values()].sort((a, b) => b.issuesCount - a.issuesCount || a.name.localeCompare(b.name));
}

async function loadAssignees(state) {
  return cached(cacheKey(state, 'assignees'), META_CACHE_TTL, () => loadAssigneesUncached(state));
}

async function loadAssigneesUncached(state) {
  const members = [];
  if (state.tokenType === 'enterprise') {
    try {
      const data = await giteeRequest(
        `${V8}/${state.enterprise.id}/members${encodeQuery('', { per_page: 100, page: 1 })}`,
        { accessToken: state.token },
      );
      members.push(...v8Items(data));
    } catch {
      // v8 member listing may be unavailable to this token; assignee picker then stays empty.
    }
  } else {
    try {
      for (let page = 1; page <= 5; page += 1) {
        const data = await giteeRequest(
          `${V5}/enterprises/${encodeURIComponent(state.enterprise.path)}/members${encodeQuery('', { per_page: 100, page })}`,
          { accessToken: state.token },
        );
        if (!Array.isArray(data) || data.length === 0) break;
        members.push(...data);
        if (data.length < 100) break;
      }
    } catch {
      // Member listing is optional; the picker stays empty if the token cannot read members.
    }
  }

  const map = new Map();
  for (const member of members) {
    const user = member?.user || member || {};
    const login = cleanText(user.login || user.username, 100);
    if (!login) continue;
    map.set(login, {
      id: Number(user.id) || 0,
      login,
      name: cleanText(member?.remark || user.name || user.remark || login, 200),
      avatarUrl: cleanText(user.avatar_url, 500),
      role: cleanText(member?.role, 50),
      active: member?.active !== false,
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function loadMeta(state, options = {}) {
  const filter = state.workItemFilter;
  const scopeKey = filter?.enabled && filter.person
    ? `${filter.scope || 'either'}:${String(filter.person).toLowerCase()}`
    : 'none';
  return cached(
    cacheKey(state, 'meta', `${scopeKey}:${options.skipScopedCounts ? 'base' : 'scoped'}`),
    META_CACHE_TTL,
    async () => {
      const meta = await loadMetaUncached(state);
      if (scopeKey === 'none' || state.tokenType !== 'enterprise' || options.skipScopedCounts) return meta;
      const counts = await loadScopedProgramCounts(state, filter, options.refresh === true);
      if (!counts) return meta;
      const scopedIssues = await loadScopedIssues(state, filter, options.refresh === true);
      return {
        ...meta,
        scopedTotal: scopedIssues?.length || 0,
        programs: meta.programs.map((program) => ({
          ...program,
          totalIssuesCount: program.issuesCount,
          issuesCount: counts[String(program.id)] || 0,
          countScoped: true,
        })),
      };
    },
    options.refresh === true,
  );
}

async function loadScopedIssues(state, filter, refresh = false) {
  if (state.tokenType !== 'enterprise' || !filter?.enabled || !filter.person) return null;
  const members = await loadAssignees(state);
  const member = members.find((item) => String(item.login).toLowerCase() === String(filter.person).toLowerCase());
  if (!member?.id) return null;
  const scope = filter.scope || 'either';
  return cached(
    cacheKey(state, 'scope-issues', `${scope}:${member.id}`),
    ISSUES_CACHE_TTL,
    async () => {
      const queries = [];
      if (scope !== 'collaborator') queries.push({ assignee_id: member.id });
      if (scope !== 'assignee') queries.push({ collaborator_ids: member.id });
      const maxPages = 100;
      const fetchScopeQuery = async (query) => {
        const payload = await giteeRequest(
          `${V8}/${state.enterprise.id}/issues${encodeQuery('', { ...query, per_page: 100, page: 1 })}`,
          { accessToken: state.token },
        );
        const first = v8Items(payload);
        const total = v8Total(payload);
        const totalPages = Math.min(maxPages, total > 0 ? Math.ceil(total / 100) : (first.length >= 100 ? maxPages : 1));
        const pages = [first];
        let nextPage = 2;
        const worker = async () => {
          while (nextPage <= totalPages) {
            const page = nextPage;
            nextPage += 1;
            try {
              const result = await giteeRequest(
                `${V8}/${state.enterprise.id}/issues${encodeQuery('', { ...query, per_page: 100, page })}`,
                { accessToken: state.token },
              );
              pages.push(v8Items(result));
            } catch {
              // Keep the pages that succeeded; a partial result is still useful.
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(5, Math.max(0, totalPages - 1)) }, worker));
        return pages.flat();
      };
      const batches = await Promise.all(queries.map(fetchScopeQuery));
      const seen = new Map();
      for (const issues of batches) {
        for (const issue of issues) {
          const issueId = Number(issue?.id) || 0;
          if (issueId && !seen.has(issueId)) seen.set(issueId, issue);
        }
      }
      return [...seen.values()];
    },
    refresh,
  );
}

async function loadScopedProgramCounts(state, filter, refresh = false) {
  const issues = await loadScopedIssues(state, filter, refresh);
  if (!issues) return null;
  const counts = {};
  for (const issue of issues) {
    const programId = Number(issue?.program_id ?? issue?.program?.id) || 0;
    if (programId) counts[programId] = (counts[programId] || 0) + 1;
  }
  return counts;
}

async function loadMetaUncached(state) {
  const [programs, assignees] = await Promise.all([loadPrograms(state), loadAssignees(state)]);
  let issueTypes = [];
  let issueStates = [];
  if (state.tokenType === 'enterprise') {
    const [types, states] = await Promise.all([v8IssueTypes(state), v8IssueStates(state)]);
    issueTypes = types.map((item) => ({
      id: Number(item.id) || 0,
      ident: cleanText(item.ident, 100),
      title: cleanText(item.title, 200),
      color: cleanText(item.color, 50),
      category: cleanText(item.category, 100),
    }));
    issueStates = states.map((item) => ({
      id: Number(item.id) || 0,
      title: cleanText(item.title, 200),
      color: cleanText(item.color, 50),
      command: cleanText(item.command, 100),
    }));
  } else {
    issueTypes = [
      { id: 0, ident: 'task', title: '任务', color: '#0086D6', category: '' },
      { id: 0, ident: 'requirement', title: '需求', color: '#7B61FF', category: '' },
      { id: 0, ident: 'bug', title: '缺陷', color: '#F05A4F', category: '' },
    ];
  }
  return { programs, assignees, issueTypes, issueStates };
}

async function loadIssues(state, filters, options = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(filters.perPage) || DEFAULT_PAGE_SIZE));
  const key = cacheKey(state, 'issues', JSON.stringify({
    type: filters.type || 'all',
    state: filters.state || 'open',
    programId: filters.programId || 0,
    search: filters.search || '',
    assignee: filters.assignee || '',
    sort: filters.sort || 'updated',
    direction: filters.direction === 'asc' ? 'asc' : 'desc',
    workItemFilter: state.workItemFilter,
    page,
    perPage,
  }));
  return cached(key, ISSUES_CACHE_TTL, () => loadIssuesUncached(state, { ...filters, page, perPage }, options), options.refresh === true);
}

const SERVER_SORT_FIELDS = new Set(['created', 'updated']);
const SORT_SCAN_MAX_PAGES = 20;
const SORT_SCAN_PAGE_SIZE = 100;

function issueSortValue(issue, sort) {
  switch (sort) {
    case 'created': return issue.createdAt || null;
    case 'updated': return issue.updatedAt || null;
    case 'priority': return issue.priority > 0 ? issue.priority : null;
    case 'planStart': return issue.planStartedAt || null;
    case 'planEnd': return issue.deadline || null;
    case 'actualStart': return issue.actualStartedAt || null;
    case 'actualEnd': return issue.finishedAt || null;
    default: return issue.updatedAt || null;
  }
}

function sortIssues(issues, sort, direction) {
  const sign = direction === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    const av = issueSortValue(a, sort);
    const bv = issueSortValue(b, sort);
    if (av == null && bv == null) return String(a.number).localeCompare(String(b.number));
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
    return cmp === 0 ? String(a.number).localeCompare(String(b.number)) : cmp * sign;
  });
}

async function scanV5ForSort(state, filters, options = {}) {
  const key = cacheKey(state, 'sortscan', JSON.stringify({
    state: filters.state || 'open',
    assignee: filters.assignee || '',
    workItemFilter: state.workItemFilter,
  }));
  return cached(key, ISSUES_CACHE_TTL, async () => {
    const first = await listV5IssuePage(state, filters, 1, SORT_SCAN_PAGE_SIZE);
    const totalPages = first.totalPages || 1;
    const pagesToRead = Math.min(totalPages, SORT_SCAN_MAX_PAGES);
    const items = [...first.items];
    for (let start = 2; start <= pagesToRead; start += 5) {
      const batch = [];
      for (let page = start; page < Math.min(start + 5, pagesToRead + 1); page += 1) {
        batch.push(listV5IssuePage(state, filters, page, SORT_SCAN_PAGE_SIZE));
      }
      const results = await Promise.all(batch);
      for (const result of results) items.push(...result.items);
    }
    return {
      items,
      scanned: items.length,
      partial: totalPages > pagesToRead,
      sourcePages: totalPages,
    };
  }, options.refresh === true);
}

async function v8IssueById(state, id) {
  return cached(
    cacheKey(state, 'v8issue', String(id)),
    DETAIL_CACHE_TTL,
    () => giteeRequest(
      `${V8}/${state.enterprise.id}/issues/${encodeURIComponent(id)}`,
      { accessToken: state.token },
    ),
  );
}

async function fillEnterpriseParents(state, issues) {
  const byId = new Map(issues.filter((issue) => issue.id).map((issue) => [String(issue.id), issue]));
  const missing = [];
  const seen = new Set();
  for (const issue of issues) {
    if (issue.parentNumber || !issue.parentId) continue;
    const key = String(issue.parentId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byId.has(key)) missing.push(issue.parentId);
  }

  const parentById = new Map();
  const results = await Promise.all(missing.slice(0, 30).map(async (parentId) => {
    try {
      return [String(parentId), await v8IssueById(state, parentId)];
    } catch {
      return null;
    }
  }));
  for (const result of results) {
    if (result) parentById.set(result[0], result[1]);
  }

  for (const issue of issues) {
    if (issue.parentNumber) {
      if (!issue.parentTitle) issue.parentTitle = byId.get(String(issue.parentId))?.title || '';
      continue;
    }
    const parent = parentById.get(String(issue.parentId));
    if (parent) {
      issue.parentNumber = cleanText(parent.ident || parent.number, 100);
      issue.parentTitle = cleanText(parent.title, 500);
    } else {
      issue.parentNumber = byId.get(String(issue.parentId))?.number || '';
      issue.parentTitle = byId.get(String(issue.parentId))?.title || '';
    }
  }
}

async function loadEnterpriseSearchIssues(state, filters, meta, refresh = false) {
  const sort = filters.sort || 'updated';
  const direction = filters.direction === 'asc' ? 'asc' : 'desc';
  const enterpriseSort = {
    created: 'created_at',
    updated: 'updated_at',
    priority: 'priority',
    planStart: 'plan_started_at',
    planEnd: 'deadline',
    actualStart: 'started_at',
    actualEnd: 'finished_at',
  }[sort] || 'updated_at';
  const assigneeLogin = filters.assignee || '';
  const assigneeMember = meta.assignees.find((item) => item.login === assigneeLogin) || null;
  const searchTerms = String(filters.search || '').split(/\s+/u).filter(Boolean);
  const serverSearch = searchTerms.sort((a, b) => b.length - a.length)[0] || filters.search;
  const baseQuery = {
    state: filters.state && filters.state !== 'all' ? filters.state : undefined,
    program_id: filters.programId || undefined,
    issue_type_id: filters.issueTypeId || undefined,
    search: serverSearch,
    assignee_id: assigneeMember?.id || undefined,
    sort: enterpriseSort,
    direction,
    per_page: 100,
  };
  return cached(
    cacheKey(state, 'search-scan', JSON.stringify(baseQuery)),
    ISSUES_CACHE_TTL,
    async () => {
      const first = await giteeRequest(
        `${V8}/${state.enterprise.id}/issues${encodeQuery('', { ...baseQuery, page: 1 })}`,
        { accessToken: state.token },
      );
      const items = v8Items(first);
      const total = v8Total(first);
      const maxPages = 20;
      const totalPages = Math.min(maxPages, total > 0
        ? Math.ceil(total / 100)
        : (items.length >= 100 ? maxPages : 1));
      const pages = [items];
      let nextPage = 2;
      const worker = async () => {
        while (nextPage <= totalPages) {
          const page = nextPage;
          nextPage += 1;
          try {
            const result = await giteeRequest(
              `${V8}/${state.enterprise.id}/issues${encodeQuery('', { ...baseQuery, page })}`,
              { accessToken: state.token },
            );
            pages.push(v8Items(result));
          } catch {
            // Keep the pages that succeeded; the result is still useful.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, Math.max(0, totalPages - 1)) }, worker));
      const all = pages.flat();
      return {
        items: all,
        scan: { scanned: all.length, partial: total > maxPages * 100 },
      };
    },
    refresh,
  );
}

async function loadIssuesUncached(state, filters, options = {}) {
  const page = filters.page;
  const perPage = filters.perPage;
  const sort = filters.sort || 'updated';
  const direction = filters.direction === 'asc' ? 'asc' : 'desc';
  const serverSort = SERVER_SORT_FIELDS.has(sort);
  const scopeFilter = state.workItemFilter;
  const scopeNeedsScan = scopeFilter?.enabled && scopeFilter.person && scopeFilter.scope !== 'assignee';
  const effectiveFilters = { ...filters };
  if (scopeFilter?.enabled && scopeFilter.scope === 'assignee' && scopeFilter.person) {
    effectiveFilters.assignee = scopeFilter.person;
  }

  const raw = state.tokenType === 'enterprise'
    ? await (async () => {
      const meta = await loadMeta(state, { ...options, skipScopedCounts: true });
      const byId = new Map(meta.programs.map((program) => [program.id, program]));
      if (scopeNeedsScan) {
        const scopedItems = await loadScopedIssues(state, scopeFilter, options.refresh === true);
        if (scopedItems) {
          return {
            meta,
            byId,
            items: scopedItems,
            scan: { items: scopedItems, scanned: scopedItems.length, partial: false },
          };
        }
      }
      if (filters.search) {
        const searched = await loadEnterpriseSearchIssues(state, filters, meta, options.refresh === true);
        return { meta, byId, items: searched.items, scan: searched.scan };
      }
      const enterpriseSort = {
        created: 'created_at',
        updated: 'updated_at',
        priority: 'priority',
        planStart: 'plan_started_at',
        planEnd: 'deadline',
        actualStart: 'started_at',
        actualEnd: 'finished_at',
      }[sort] || 'updated_at';
      const assigneeLogin = effectiveFilters.assignee || filters.assignee || '';
      const assigneeMember = meta.assignees.find((item) => item.login === assigneeLogin) || null;
      const query = {
        page,
        per_page: perPage,
        state: filters.state && filters.state !== 'all' ? filters.state : undefined,
        program_id: filters.programId || undefined,
        issue_type_id: filters.issueTypeId || undefined,
        search: filters.search || undefined,
        assignee_id: assigneeMember?.id || undefined,
        sort: enterpriseSort,
        direction,
      };
      const result = await giteeRequestResponse(
        `${V8}/${state.enterprise.id}/issues${encodeQuery('', query)}`,
        { accessToken: state.token },
      );
      const items = v8Items(result.payload);
      const total = v8Total(result.payload);
      const totalPages = total > 0
        ? Math.max(1, Math.ceil(total / perPage))
        : totalPagesFromLink(result.headers.get('link'));
      return {
        meta,
        byId,
        items,
        totalPages,
        hasMore: totalPages > 0 ? page < totalPages : items.length >= perPage,
      };
    })()
    : await (async () => {
      if (serverSort && !scopeNeedsScan) {
        const result = await listV5IssuePage(state, effectiveFilters, page, perPage);
        return { meta: null, byId: null, ...result };
      }
      const scan = await scanV5ForSort(state, effectiveFilters, options);
      return { meta: null, byId: null, items: scan.items, scan };
    })();

  const normalized = raw.items.map((issue) => normalizeIssue(issue, {
    enterprise: state.enterprise,
    programsById: raw.byId,
  }));
  if (state.tokenType === 'enterprise') {
    await fillEnterpriseParents(state, normalized);
  }
  const scoped = normalized.filter((issue) => matchesWorkItemFilter(issue, state.workItemFilter));
  const filtered = scoped.filter((issue) => matchesFilters(issue, filters));

  if (raw.scan) {
    const sorted = sortIssues(filtered, sort, direction);
    const total = sorted.length;
    const start = (page - 1) * perPage;
    const issues = sorted.slice(start, start + perPage);
    return {
      issues,
      page,
      perPage,
      matched: issues.length,
      totalMatches: total,
      pageSize: raw.scan.scanned,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      hasMore: start + perPage < total,
      filtered: true,
      partial: raw.scan.partial,
      scanned: raw.scan.scanned,
      programs: raw.meta?.programs,
      assignees: raw.meta?.assignees,
      issueTypes: raw.meta?.issueTypes,
      issueStates: raw.meta?.issueStates,
    };
  }

  return {
    issues: filtered,
    page,
    perPage,
    matched: filtered.length,
    pageSize: raw.items.length,
    totalPages: raw.totalPages || (raw.hasMore ? page + 1 : page),
    hasMore: raw.hasMore,
    filtered: filtered.length !== normalized.length,
    partial: false,
    scanned: raw.items.length,
    programs: raw.meta?.programs,
    assignees: raw.meta?.assignees,
    issueTypes: raw.meta?.issueTypes,
    issueStates: raw.meta?.issueStates,
  };
}

async function getIssue(state, number, options = {}) {
  return cached(
    cacheKey(state, 'detail', String(number).toUpperCase()),
    DETAIL_CACHE_TTL,
    () => getIssueUncached(state, number),
    options.refresh === true,
  );
}

async function v8IssueId(state, number) {
  const value = String(number || '');
  if (/^\d+$/u.test(value)) return value;
  const result = await giteeRequestResponse(
    `${V8}/${state.enterprise.id}/issues${encodeQuery('', { search: value, per_page: 20, page: 1 })}`,
    { accessToken: state.token },
  );
  const found = v8Items(result.payload).find((issue) => (
    String(issue?.ident) === value || String(issue?.number) === value
  ));
  return found?.id ? String(found.id) : null;
}

async function getIssueUncached(state, number) {
  if (state.tokenType === 'enterprise') {
    const id = await v8IssueId(state, number);
    if (!id) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
    const data = await giteeRequest(
      `${V8}/${state.enterprise.id}/issues/${encodeURIComponent(id)}`,
      { accessToken: state.token },
    );
    const programs = await loadPrograms(state);
    const byId = new Map(programs.map((program) => [program.id, program]));
    return normalizeIssue(data, { enterprise: state.enterprise, programsById: byId });
  }
  const data = await giteeRequest(
    `${V5}/enterprises/${encodeURIComponent(state.enterprise.path)}/issues/${encodeURIComponent(number)}`,
    { accessToken: state.token },
  );
  return normalizeIssue(data, { enterprise: state.enterprise });
}

async function listChildIssues(state, number, query = {}, options = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.perPage) || 100));
  if (state.tokenType !== 'enterprise') {
    return { children: [], total: 0, page, perPage, totalPages: 0, unsupported: true };
  }
  const parent = await getIssue(state, number);
  if (!parent?.id) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
  return cached(
    cacheKey(state, 'children', `${number}:${page}:${perPage}`),
    DETAIL_CACHE_TTL,
    async () => {
      const programs = await loadPrograms(state);
      const byId = new Map(programs.map((program) => [program.id, program]));
      const payload = await giteeRequest(
        `${V8}/${state.enterprise.id}/issues${encodeQuery('', {
          parent_id: parent.id,
          page,
          per_page: perPage,
        })}`,
        { accessToken: state.token },
      );
      const total = v8Total(payload);
      const children = v8Items(payload).map((item) => {
        const child = normalizeIssue(item, { enterprise: state.enterprise, programsById: byId });
        child.parentNumber = parent.number;
        child.parentTitle = parent.title;
        return child;
      });
      return {
        children,
        total,
        page,
        perPage,
        totalPages: total > 0 ? Math.max(1, Math.ceil(total / perPage)) : 0,
      };
    },
    options.refresh === true,
  );
}

function normalizeComment(item) {
  const author = item?.author || item?.user || {};
  return {
    id: item?.id ?? null,
    body: cleanText(item?.content || item?.body || '', 20_000),
    author: {
      id: Number(author?.id) || 0,
      login: cleanText(author?.username || author?.login || '', 100),
      name: cleanText(author?.name || author?.remark || author?.username || author?.login || '', 200),
      avatarUrl: cleanText(author?.avatar_url, 500),
    },
    createdAt: item?.created_at || null,
    updatedAt: item?.updated_at || null,
    canDelete: Boolean(item?.operating?.can_delete),
  };
}

async function listComments(state, number, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.perPage) || 20));
  const issue = await getIssue(state, number);
  if (state.tokenType === 'enterprise') {
    if (!issue.id) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
    const payload = await giteeRequest(
      `${V8}/${state.enterprise.id}/issues/${encodeURIComponent(issue.id)}/notes${encodeQuery('', {
        page,
        per_page: perPage,
        sort: 'created_at',
        direction: 'asc',
      })}`,
      { accessToken: state.token },
    );
    const total = v8Total(payload);
    return {
      comments: v8Items(payload).map(normalizeComment),
      total,
      page,
      perPage,
      totalPages: total > 0 ? Math.max(1, Math.ceil(total / perPage)) : 0,
    };
  }
  const payload = await giteeRequest(
    `${V5}/enterprises/${encodeURIComponent(state.enterprise.path)}/issues/${encodeURIComponent(number)}/comments${encodeQuery('', {
      page,
      per_page: perPage,
      sort: 'created_at',
      direction: 'asc',
    })}`,
    { accessToken: state.token },
  );
  const comments = (Array.isArray(payload) ? payload : v8Items(payload)).map(normalizeComment);
  return {
    comments,
    total: comments.length,
    page,
    perPage,
    totalPages: comments.length >= perPage ? page + 1 : page,
  };
}

async function addComment(state, number, body) {
  const text = cleanText(body?.body ?? body?.content, 20_000).trim();
  if (!text) throw new AppError('comment_required', '评论内容不能为空。', 400);
  const issue = await getIssue(state, number);
  let result;
  if (state.tokenType === 'enterprise') {
    if (!issue.id) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
    result = await giteeRequest(
      `${V8}/${state.enterprise.id}/issues/${encodeURIComponent(issue.id)}/notes`,
      { method: 'POST', accessToken: state.token, json: { body: text } },
    );
  } else {
    result = await giteeRequest(
      `${V5}/enterprises/${encodeURIComponent(state.enterprise.path)}/issues/${encodeURIComponent(number)}/comments`,
      { method: 'POST', accessToken: state.token, form: { body: text } },
    );
  }
  return normalizeComment(result);
}

async function createIssue(state, body) {
  if (state.tokenType !== 'enterprise') {
    throw new AppError(
      'capability_required',
      '当前连接的是私人令牌，只能读取和更新工作项；新建与删除需要企业 MCP 令牌。',
      403,
    );
  }
  const title = cleanText(body.title, 500).trim();
  if (!title) throw new AppError('title_required', '请填写标题。', 400);
  const form = {
    title,
    description: cleanText(body.description, 50_000),
    program_id: body.programId || undefined,
    issue_type_id: body.issueTypeId || undefined,
    priority: body.priority ?? undefined,
    assignee_id: body.assigneeId || undefined,
  };
  const data = await giteeRequest(`${V8}/${state.enterprise.id}/issues`, {
    method: 'POST',
    accessToken: state.token,
    json: form,
  });
  clearResponseCache();
  return normalizeIssue(data, { enterprise: state.enterprise });
}

async function updateIssue(state, number, body) {
  const patch = {};
  if (body.title !== undefined) {
    const title = cleanText(body.title, 500).trim();
    if (!title) throw new AppError('title_required', '标题不能为空。', 400);
    patch.title = title;
  }
  if (body.description !== undefined) {
    if (state.tokenType === 'enterprise') patch.description = cleanText(body.description, 50_000);
    else patch.body = cleanText(body.description, 50_000);
  }
  if (body.state !== undefined && body.state) {
    if (state.tokenType === 'enterprise') patch.issue_state_id = body.state;
    else patch.state = body.state;
  }
  if (body.priority !== undefined) patch.priority = body.priority;
  if (!Object.keys(patch).length) throw new AppError('empty_update', '没有需要更新的字段。', 400);

  if (state.tokenType === 'enterprise') {
    const current = await getIssue(state, number);
    const targetId = current.id;
    if (!targetId) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
    await giteeRequest(`${V8}/${state.enterprise.id}/issues/${encodeURIComponent(targetId)}`, {
      method: 'PUT',
      accessToken: state.token,
      json: patch,
    });
  } else {
    await giteeRequest(`${V5}/enterprises/${encodeURIComponent(state.enterprise.path)}/issues/${encodeURIComponent(number)}`, {
      method: 'PATCH',
      accessToken: state.token,
      form: patch,
    });
  }
  clearResponseCache();
  return getIssue(state, number);
}

async function deleteIssue(state, number, confirmed = false) {
  if (state.tokenType !== 'enterprise') {
    throw new AppError(
      'capability_required',
      '当前连接的是私人令牌，不能删除工作项；删除需要企业 MCP 令牌。',
      403,
    );
  }
  if (!confirmed) {
    throw new AppError('confirmation_required', '删除工作项需要显式确认（confirm=1）。', 400);
  }
  const current = await getIssue(state, number);
  const targetId = current.id;
  if (!targetId) throw new AppError('issue_not_found', `找不到工作项：${number}`, 404);
  await giteeRequest(`${V8}/${state.enterprise.id}/issues/${encodeURIComponent(targetId)}`, {
    method: 'DELETE',
    accessToken: state.token,
  });
  clearResponseCache();
  return { deleted: true, number: String(number) };
}

async function selfTest(state, body) {
  if (state.tokenType !== 'enterprise') {
    return {
      skipped: true,
      reason: '私人令牌不支持创建/删除企业工作项，已跳过破坏性自检；未改动任何现有数据。',
      readOnly: true,
    };
  }
  if (body.confirm !== true) {
    throw new AppError('confirmation_required', '自检会新建并删除一条测试工作项，请显式确认。', 400);
  }
  const title = `[DSH-TEST] 删除安全自检 ${new Date().toISOString()}`;
  const created = await createIssue(state, {
    title,
    description: '由 Gitee 企业工作台插件自动创建，仅用于验证新建/删除闭环，完成后会立即删除。',
    programId: body.programId,
    issueTypeId: body.issueTypeId,
    priority: 0,
  });
  if (!created.number) {
    return { skipped: false, created: null, deleted: false, reason: '创建成功但响应中没有工作项编号，未执行删除。' };
  }
  try {
    await deleteIssue(state, created.number, true);
    return {
      skipped: false,
      created: { number: created.number, title: created.title },
      deleted: true,
      reason: '已创建测试工作项并立即删除，未触碰现有数据。',
    };
  } catch (error) {
    return {
      skipped: false,
      created: { number: created.number, title: created.title },
      deleted: false,
      reason: `测试工作项已创建但删除失败：${error?.message || error}。请手动清理编号 ${created.number}。`,
    };
  }
}

export async function apply(ctx) {
  const store = new StateStore(path.join(resolveProfileDirectory(), 'gitee-enterprise'), ctx.logger);
  await store.init();

  const requireConnection = () => {
    const state = store.state;
    if (!state?.token || !state?.tokenType || !state?.enterprise) {
      throw new AppError('not_configured', '请先在 Gitee 企业工作台中配置令牌。', 401);
    }
    return state;
  };

  const handleState = async () => publicState(store.state);

  const handleSettings = async (body) => {
    const input = body?.workItemFilter || body?.filter || {};
    const scope = ['either', 'assignee', 'collaborator'].includes(input.scope) ? input.scope : 'either';
    const enabled = input.enabled === true;
    const person = cleanText(input.person, 100).trim();
    if (enabled && !person) {
      throw new AppError('filter_person_required', '启用工作项范围限制时，请选择负责人或协作人。', 400);
    }
    await store.update({
      workItemFilter: {
        enabled,
        person,
        personName: cleanText(input.personName, 200).trim(),
        scope,
      },
    });
    clearResponseCache();
    return publicState(store.state);
  };

  const handleConfig = async (body) => {
    const provided = cleanText(body.token, 4096).trim();
    const token = provided || store.state.token;
    if (!token) throw new AppError('token_required', '请填写 Gitee 令牌。', 400);
    const requested = cleanText(body.enterpriseId, 200).trim();
    const detected = await detectToken(token, requested);
    await store.update({
      token,
      tokenType: detected.tokenType,
      account: detected.account,
      enterprise: detected.enterprise,
    });
    clearResponseCache();
    return {
      ...publicState(store.state),
      enterprises: detected.enterprises,
    };
  };

  const handlePrograms = async (search) => {
    const state = requireConnection();
    return loadMeta(state, { refresh: search.get('refresh') === '1' });
  };

  const handleIssues = async (search) => {
    const state = requireConnection();
    const filters = {
      type: cleanText(search.get('type') || 'all', 40),
      state: cleanText(search.get('state') || 'open', 40),
      programId: Number(search.get('programId')) || 0,
      issueTypeId: Number(search.get('issueTypeId')) || 0,
      search: cleanText(search.get('search') || '', 200),
      assignee: cleanText(search.get('assignee') || '', 100),
      sort: cleanText(search.get('sort') || 'updated', 40),
      direction: cleanText(search.get('direction') || 'desc', 10),
      page: Number(search.get('page')) || 1,
      perPage: Number(search.get('perPage') || search.get('per_page')) || DEFAULT_PAGE_SIZE,
    };
    return loadIssues(state, filters, { refresh: search.get('refresh') === '1' });
  };

  const dispatch = async (req, res, url) => {
    const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (segments.length === 0 && method === 'GET') {
      sendOk(res, await handleState());
      return;
    }
    if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
      sendOk(res, await handleState());
      return;
    }
    if (segments.length === 1 && segments[0] === 'settings' && method === 'POST') {
      sendOk(res, await handleSettings(await readJson(req)));
      return;
    }
    if (segments.length === 1 && segments[0] === 'config' && method === 'POST') {
      sendOk(res, await handleConfig(await readJson(req)));
      return;
    }
    if (segments.length === 1 && segments[0] === 'disconnect' && method === 'POST') {
      await store.clear();
      clearResponseCache();
      sendOk(res, publicState(store.state));
      return;
    }
    if (segments.length === 1 && segments[0] === 'programs' && method === 'GET') {
      sendOk(res, await handlePrograms(url.searchParams));
      return;
    }
    if (segments.length === 1 && segments[0] === 'issues' && method === 'GET') {
      sendOk(res, await handleIssues(url.searchParams));
      return;
    }
    if (segments.length === 1 && segments[0] === 'issues' && method === 'POST') {
      sendOk(res, await createIssue(requireConnection(), await readJson(req)), 201);
      return;
    }
    if (segments.length === 2 && segments[0] === 'issues' && method === 'GET') {
      sendOk(res, await getIssue(requireConnection(), segments[1], { refresh: url.searchParams.get('refresh') === '1' }));
      return;
    }
    if (segments.length === 3 && segments[0] === 'issues' && segments[2] === 'children' && method === 'GET') {
      sendOk(res, await listChildIssues(requireConnection(), segments[1], {
        page: Number(url.searchParams.get('page')) || 1,
        perPage: Number(url.searchParams.get('perPage') || url.searchParams.get('per_page')) || 100,
      }));
      return;
    }
    if (segments.length === 3 && segments[0] === 'issues' && segments[2] === 'comments' && method === 'GET') {
      sendOk(res, await listComments(requireConnection(), segments[1], {
        page: Number(url.searchParams.get('page')) || 1,
        perPage: Number(url.searchParams.get('perPage') || url.searchParams.get('per_page')) || 20,
      }));
      return;
    }
    if (segments.length === 3 && segments[0] === 'issues' && segments[2] === 'comments' && method === 'POST') {
      sendOk(res, await addComment(requireConnection(), segments[1], await readJson(req)), 201);
      return;
    }
    if (segments.length === 2 && segments[0] === 'issues' && method === 'PATCH') {
      sendOk(res, await updateIssue(requireConnection(), segments[1], await readJson(req)));
      return;
    }
    if (segments.length === 2 && segments[0] === 'issues' && method === 'DELETE') {
      sendOk(res, await deleteIssue(requireConnection(), segments[1], url.searchParams.get('confirm') === '1'));
      return;
    }
    if (segments.length === 1 && segments[0] === 'selftest' && method === 'POST') {
      sendOk(res, await selfTest(requireConnection(), await readJson(req)));
      return;
    }
    throw new AppError('not_found', `未知接口：${method} ${url.pathname}`, 404);
  };

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        await dispatch(req, res, url);
      } catch (error) {
        const appError = asAppError(error);
        if (appError.status >= 500) {
          ctx.logger?.warn?.(`gitee-enterprise: ${req.method} ${req.url} failed: ${appError.message}`);
        }
        sendError(res, appError);
      }
    },
  });

  ctx.effect(() => () => dispose(), 'gitee-enterprise: HTTP routes');
}
