'use strict';

const path = require('node:path');
const { unique } = require('./util');

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.cs', '.fs', '.fsx', '.vb', '.java', '.kt', '.kts', '.scala',
  '.go', '.rs', '.swift', '.m', '.mm', '.py', '.pyi', '.r', '.rb',
  '.php', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.sql', '.graphql',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.yaml', '.yml', '.json', '.jsonc', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.proto', '.md', '.rst', '.tex', '.dockerfile', '.gradle',
  '.tf', '.tfvars', '.lua', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs',
]);

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'can', 'code', 'could',
  'debug', 'explain', 'file', 'for', 'from', 'function', 'generate', 'help',
  'how', 'into', 'issue', 'make', 'please', 'refactor', 'review', 'should',
  'that', 'the', 'this', 'use', 'using', 'what', 'when', 'where', 'which',
  'with', 'would', 'write', 'you', 'your',
]);

const EXCLUDED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', '.vscode-test', '.history',
  '.ssh', '.aws', '.azure', '.gnupg', '.kube',
  'node_modules', 'bower_components', 'vendor', 'third_party', 'third-party',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.turbo',
  'bin', 'obj', 'models', 'checkpoints', 'weights',
]);

const SENSITIVE_BASENAMES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', '_netrc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'secrets.json', 'secret.json',
  'service-account.json', 'service_account.json', 'known_hosts',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.kdbx',
  '.crt', '.cer', '.der', '.safetensors', '.gguf', '.onnx', '.pt', '.pth',
  '.sqlite', '.sqlite3', '.db', '.bak', '.dump', '.log',
]);

function normalizedRelativePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSensitivePath(relativePath) {
  const normalized = normalizedRelativePath(relativePath);
  const lower = normalized.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1) ?? '';
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith('.env.')) return true;
  if (/^(credentials|secrets?|tokens?)(\.|$)/i.test(basename)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(basename))) return true;
  if (/\.(min\.js|min\.css|map)$/i.test(basename)) return true;
  return false;
}

function isLikelySourcePath(relativePath) {
  if (isSensitivePath(relativePath)) return false;
  const normalized = normalizedRelativePath(relativePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  if (/^(dockerfile|makefile|cmakelists\.txt|justfile|rakefile|gemfile|procfile)$/i.test(basename)) {
    return true;
  }
  return SOURCE_EXTENSIONS.has(path.posix.extname(basename));
}

function splitIdentifier(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9_$.-]+/g, ' ')
    .split(/[\s._$-]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function extractTerms(query) {
  return unique(
    splitIdentifier(query).filter(
      (term) => term.length >= 3 && term.length <= 64 && !STOP_WORDS.has(term) && !/^\d+$/.test(term)
    )
  ).slice(0, 24);
}

function countOccurrences(haystack, needle, limit = 8) {
  let count = 0;
  let position = 0;
  while (count < limit) {
    position = haystack.indexOf(needle, position);
    if (position < 0) break;
    count += 1;
    position += needle.length;
  }
  return count;
}

function scoreCandidate(relativePath, content, terms, activeDirectory = '') {
  const pathText = normalizedRelativePath(relativePath).toLowerCase();
  const body = String(content ?? '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += countOccurrences(pathText, term, 3) * 8;
    score += countOccurrences(body, term, 5) * 2;
  }
  if (activeDirectory && pathText.startsWith(activeDirectory.toLowerCase())) score += 3;
  if (/^(readme|contributing|architecture|package\.json|pyproject\.toml)/i.test(path.posix.basename(pathText))) {
    score += 1;
  }
  return score;
}


// Every tag the prompt uses to frame untrusted text must appear here. A tag
// added to a prompt but forgotten here lets file content close its own block and
// address the model as though it were the extension.
const RESERVED_CONTEXT_TAGS = ['workspace_context', 'project_memory', 'file', 'diagnostics'];

function neutralizeContextMarkup(value) {
  const pattern = new RegExp(`<(/?)(${RESERVED_CONTEXT_TAGS.join('|')})(?=[\\s>])`, 'gi');
  return String(value ?? '').replace(pattern, (_match, slash, name) => `&lt;${slash}${name}`);
}

function codeFenceFor(value) {
  const text = String(value ?? '');
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function languageFence(documentOrPath) {
  const value = typeof documentOrPath === 'string' ? documentOrPath : documentOrPath.languageId;
  const ext = typeof documentOrPath === 'string' ? path.extname(documentOrPath).slice(1) : '';
  return String(value || ext || 'text').replace(/[^a-zA-Z0-9_+-]/g, '');
}

module.exports = {
  RESERVED_CONTEXT_TAGS,
  extractTerms,
  codeFenceFor,
  isLikelySourcePath,
  isSensitivePath,
  languageFence,
  neutralizeContextMarkup,
  normalizedRelativePath,
  scoreCandidate,
};
