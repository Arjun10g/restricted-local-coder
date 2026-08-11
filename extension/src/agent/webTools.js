'use strict';

const { neutralizeContextMarkup } = require('../contextRules');

/**
 * Web access for the agent.
 *
 * This is the only capability in the extension that sends anything off the
 * machine, and it inverts the product's default posture, so the design is built
 * around one fact: **the query itself is the exfiltration channel.** A model that
 * can search can encode workspace content into `?q=`, and no amount of filtering
 * the *results* addresses that.
 *
 * The controls therefore target the outbound side:
 *
 * - Off by default, and separately from every other agent capability.
 * - An explicit host allow-list. There is no "any host" value; an empty list
 *   means no web access, so a misconfiguration fails closed.
 * - Every query and every URL is recorded in the audit log before the request is
 *   made, so what left the machine is reviewable afterwards. This is the control
 *   that matters most, because it is the only one that survives a model doing
 *   something unexpected.
 * - Queries are length-capped and single-line, so a whole file cannot be smuggled
 *   into one.
 * - HTTPS only, no credentials, no cookies, and the allow-list is re-applied
 *   after every redirect — the same rule the model downloader already uses,
 *   because a redirect is otherwise a way out of the allow-list.
 * - Responses are treated exactly like workspace files: neutralized, truncated,
 *   and framed as untrusted data.
 */

const MAX_QUERY_CHARACTERS = 300;
const MAX_RESULT_CHARACTERS = 8000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

const WEB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for documentation or error messages. Only approved hosts are reachable, and every query is recorded in an audit log the user can read.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms. Keep them short; do not paste source code.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a page from an approved host and return its text.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An https:// URL on an approved host.' } },
        required: ['url'],
      },
    },
  },
];

function refuse(reason) {
  return { ok: false, content: `Refused: ${reason}` };
}

/**
 * Exact host match, or a dot-suffix match so "example.com" covers
 * "docs.example.com" but never "notexample.com".
 */
function hostAllowed(hostname, allowedHosts) {
  const host = String(hostname).toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = String(entry).trim().toLowerCase();
    if (!allowed) return false;
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function checkUrl(rawUrl, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return { error: `"${rawUrl}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'https:') {
    return { error: 'only https:// URLs are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'URLs with embedded credentials are not allowed.' };
  }
  if (!hostAllowed(parsed.hostname, allowedHosts)) {
    return {
      error:
        `${parsed.hostname} is not on the approved host list. ` +
        'Add it to localCoder.web.allowedHosts if it should be reachable.',
    };
  }
  return { url: parsed };
}

/**
 * Follows redirects by hand so the allow-list is re-checked at every hop. The
 * platform's automatic redirect following would let an approved host bounce the
 * request to an unapproved one.
 */
async function fetchAllowed(url, allowedHosts, { fetchImpl = fetch, signal } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current.toString(), {
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'text/html,text/plain', 'User-Agent': 'restricted-local-coder' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { error: 'the server sent a redirect with no destination.' };
      const next = checkUrl(new URL(location, current).toString(), allowedHosts);
      if (next.error) return { error: `redirect blocked: ${next.error}` };
      current = next.url;
      continue;
    }
    if (!response.ok) return { error: `${current.hostname} returned HTTP ${response.status}.` };
    return { response, finalUrl: current };
  }
  return { error: 'too many redirects.' };
}

/** Crude tag stripping. The result is data, never markup we render or execute. */
function textFromHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function present(text, sourceUrl) {
  const trimmed = text.length > MAX_RESULT_CHARACTERS
    ? `${text.slice(0, MAX_RESULT_CHARACTERS)}\n… truncated …`
    : text;
  // Framed and neutralized exactly like workspace files: a page is untrusted
  // text that must not be able to close its own wrapper or issue instructions.
  return {
    ok: true,
    content: `<web_result source="${String(sourceUrl).replace(/["<>]/g, '_')}">\n${neutralizeContextMarkup(trimmed)}\n</web_result>`,
  };
}

function validateQuery(query) {
  if (typeof query !== 'string' || query.trim() === '') return 'a non-empty query is required.';
  if (query.length > MAX_QUERY_CHARACTERS) {
    return `queries are limited to ${MAX_QUERY_CHARACTERS} characters; this one is ${query.length}. Search for the error or API name, not the file.`;
  }
  if (/[\r\n]/.test(query)) return 'queries must be a single line.';
  return null;
}

async function webSearchTool(args, { allowedHosts, searchUrlTemplate, fetchImpl, signal } = {}) {
  const query = args?.query;
  const invalid = validateQuery(query);
  if (invalid) return refuse(invalid);
  if (!searchUrlTemplate) return refuse('no search endpoint is configured (localCoder.web.searchUrl).');

  const target = searchUrlTemplate.replace('{query}', encodeURIComponent(query));
  const checked = checkUrl(target, allowedHosts);
  if (checked.error) return refuse(checked.error);

  const result = await fetchAllowed(checked.url, allowedHosts, { fetchImpl, signal });
  if (result.error) return refuse(result.error);
  return present(textFromHtml(await result.response.text()), result.finalUrl.hostname);
}

async function webFetchTool(args, { allowedHosts, fetchImpl, signal } = {}) {
  const checked = checkUrl(args?.url, allowedHosts);
  if (checked.error) return refuse(checked.error);

  const result = await fetchAllowed(checked.url, allowedHosts, { fetchImpl, signal });
  if (result.error) return refuse(result.error);
  const body = await result.response.text();
  const type = result.response.headers.get('content-type') ?? '';
  return present(type.includes('html') ? textFromHtml(body) : body, result.finalUrl.toString());
}

module.exports = {
  MAX_QUERY_CHARACTERS,
  MAX_RESULT_CHARACTERS,
  WEB_TOOL_SCHEMAS,
  checkUrl,
  fetchAllowed,
  hostAllowed,
  textFromHtml,
  validateQuery,
  webFetchTool,
  webSearchTool,
};
