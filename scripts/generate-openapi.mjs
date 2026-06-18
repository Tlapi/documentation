#!/usr/bin/env node
// Generate an OpenAPI 3.1 spec from the Mintlify MDX API reference.
//
// Source of truth: the endpoint MDX files referenced by docs.json's "API reference" tab.
// A ParamField's `body` attribute carries the full path from the root (e.g.
// "message.to[].email"), so the nested schema is rebuilt from those paths alone.
//
// Usage: node scripts/generate-openapi.mjs [--out openapi.json] [--root <dir>]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error',
};

// Short descriptions per navigation group (keyed by docs.json group name).
const TAG_DESCRIPTIONS = {
  'Automations': 'Trigger automation pipelines and read automation statistics.',
  'Campaigns': 'Create, send, and analyze email campaigns.',
  'Discount coupons': 'Import and delete discount coupons.',
  'Domains': 'Manage sending domains and their verification status.',
  'Feeds': 'Refresh product feed data used for personalization.',
  'Lists': 'Manage subscriber lists and the subscribers within them.',
  'Recommenders': 'Manage product recommendation engines.',
  'Search': 'Search for contacts across your account.',
  'Subscribers': 'Read subscriber profiles, events, and activity logs.',
  'Templates': 'Manage reusable email templates.',
  'Tracker events': 'Send custom tracking events for contacts.',
  'Transactional emails': 'Send transactional messages and read their statistics.',
  'Transactions': 'Record and manage e-commerce transactions.',
  'Webhooks': 'Configure webhook URLs for real-time event delivery.',
};

// ---------- parsing helpers ----------

function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return { fm, body: src };
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    fm[mm[1]] = v;
  }
  return { fm, body: src.slice(m[0].length) };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

// Every <ParamField>, flattened. Description = text between the opening tag and the next tag.
function parseParamFields(body) {
  const fields = [];
  let i = 0;
  while (true) {
    const start = body.indexOf('<ParamField', i);
    if (start === -1) break;
    const gt = body.indexOf('>', start);
    if (gt === -1) break;
    const tag = body.slice(start, gt);
    const nextLt = body.indexOf('<', gt + 1);
    const desc = body.slice(gt + 1, nextLt === -1 ? body.length : nextLt)
      .replace(/\s+/g, ' ').trim();

    let location, name;
    for (const loc of ['path', 'query', 'header', 'body']) {
      const v = attr(tag, loc);
      if (v !== undefined) { location = loc; name = v; break; }
    }
    if (location) {
      fields.push({
        location,
        name,
        type: attr(tag, 'type') || 'string',
        required: /\brequired\b/.test(tag),
        default: attr(tag, 'default'),
        desc: desc || undefined,
      });
    }
    i = gt + 1;
  }
  return fields;
}

// "message.to[].email" -> [{name:'message'},{name:'to',isArray:true},{name:'email'}]
function pathToSegments(name) {
  const segments = [];
  const re = /\.?([A-Za-z0-9_]+)|\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(name)) !== null) {
    if (m[1] !== undefined) {
      segments.push({ name: m[1], isArray: false });
    } else if (m[2] === '') {
      if (segments.length) segments[segments.length - 1].isArray = true;
    } else {
      segments.push({ name: m[2], isArray: false });
    }
  }
  return segments;
}

function mapTypes(typeStr) {
  const norm = (t) => {
    t = t.trim();
    return ['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(t) ? t : 'string';
  };
  return (typeStr || 'string').split('|').map(norm);
}

// True for both a plain 'array' type and a union (e.g. ['array','object']) that includes it.
function arrayTyped(type) {
  return type === 'array' || (Array.isArray(type) && type.includes('array'));
}

function coerceDefault(raw, primaryType) {
  if (raw === undefined) return undefined;
  if (primaryType === 'integer' || primaryType === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (primaryType === 'boolean') return raw === 'true';
  return raw;
}

// ---------- schema building ----------

function ensureObject(schema) {
  if (schema.type !== 'object') schema.type = 'object';
  if (!schema.properties) schema.properties = {};
  return schema;
}

function addRequired(schema, name) {
  if (!schema.required) schema.required = [];
  if (!schema.required.includes(name)) schema.required.push(name);
}

function applyLeaf(prop, field) {
  const types = mapTypes(field.type);
  if (prop.type !== 'object' && prop.type !== 'array') {
    prop.type = types.length === 1 ? types[0] : types;
  }
  if (field.desc && !prop.description) prop.description = field.desc;
  const def = coerceDefault(field.default, types[0]);
  if (def !== undefined) prop.default = def;
  if (arrayTyped(prop.type) && !prop.items) prop.items = {};
}

// Rebuild a nested property from a single ParamField path expression.
function insertBody(root, field) {
  const segments = pathToSegments(field.name);
  if (!segments.length) return;
  let container = ensureObject(root);
  segments.forEach((seg, idx) => {
    const last = idx === segments.length - 1;
    if (!container.properties) container.properties = {};
    let prop = container.properties[seg.name] || (container.properties[seg.name] = {});

    if (last) {
      if (field.required) addRequired(container, seg.name);
      if (seg.isArray) {
        prop.type = 'array';
        if (!prop.items) prop.items = {};
        if (field.desc && !prop.description) prop.description = field.desc;
      } else {
        applyLeaf(prop, field);
      }
    } else if (seg.isArray) {
      prop.type = 'array';
      if (!prop.items) prop.items = {};
      container = ensureObject(prop.items);
    } else {
      container = ensureObject(prop);
    }
  });
}

// ---------- examples & responses ----------

function extractRequestBodyExample(body) {
  const sec = body.match(/<RequestExample>([\s\S]*?)<\/RequestExample>/);
  if (!sec) return undefined;
  const blocks = [...sec[1].matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const curl = blocks.find((b) => /curl/i.test(b) && b.includes("-d '"));
  if (!curl) return undefined;
  const start = curl.indexOf("-d '");
  const rest = curl.slice(start + 4);
  const end = rest.lastIndexOf("'");
  if (end === -1) return undefined;
  const json = rest.slice(0, end).replace(/'\\''/g, "'");
  try { return JSON.parse(json); } catch { return undefined; }
}

function jsonToSchema(val) {
  if (val === null) return {};
  if (Array.isArray(val)) return { type: 'array', items: val.length ? jsonToSchema(val[0]) : {} };
  switch (typeof val) {
    case 'string': return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'number': return { type: Number.isInteger(val) ? 'integer' : 'number' };
    case 'object': {
      const properties = {};
      for (const k of Object.keys(val)) properties[k] = jsonToSchema(val[k]);
      return { type: 'object', properties };
    }
    default: return {};
  }
}

function extractResponses(body) {
  const sec = body.match(/<ResponseExample>([\s\S]*?)<\/ResponseExample>/);
  const responses = {};
  if (!sec) return responses;
  const re = /```json\s+(\d{3})[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(sec[1])) !== null) {
    const code = m[1];
    let example;
    try { example = JSON.parse(m[2]); } catch { example = undefined; }
    const content = { 'application/json': {} };
    if (example !== undefined) {
      content['application/json'].schema = jsonToSchema(example);
      content['application/json'].example = example;
    }
    responses[code] = { description: STATUS_TEXT[code] || 'Response', content };
  }
  return responses;
}

// ---------- navigation (docs.json) ----------

function collectPages(group, acc) {
  for (const page of group.pages || []) {
    if (typeof page === 'string') acc.push({ path: page, group: group.group });
    else if (page && page.pages) collectPages({ ...page, group: page.group || group.group }, acc);
  }
}

function buildPageList(docs) {
  const tab = docs.navigation.tabs.find((t) => t.tab === 'API reference');
  if (!tab) throw new Error('No "API reference" tab in docs.json');
  const pages = [];
  for (const group of tab.groups || []) collectPages(group, pages);
  return pages;
}

function operationId(pagePath) {
  return pagePath
    .replace(/^api-reference\//, '')
    .replace(/[\/-]+(.)/g, (_, c) => c.toUpperCase());
}

// ---------- spec assembly ----------

export function generateSpec(root) {
  const docs = JSON.parse(readFileSync(join(root, 'docs.json'), 'utf8'));
  const server = docs.api?.mdx?.server || 'https://api2.ecomailapp.cz';
  const authName = docs.api?.mdx?.auth?.name || 'key';

  const paths = {};
  const tagsUsed = [];
  const tagOrder = [];
  const stats = { operations: 0, skipped: [], noResponses: [] };

  for (const { path: pagePath, group } of buildPageList(docs)) {
    const file = join(root, `${pagePath}.mdx`);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { stats.skipped.push(`${pagePath} (file missing)`); continue; }

    const { fm, body } = parseFrontmatter(src);
    if (!fm.api) { stats.skipped.push(`${pagePath} (no api: frontmatter)`); continue; }

    const apiMatch = fm.api.match(/^([A-Z]+)\s+(\S+)/);
    if (!apiMatch) { stats.skipped.push(`${pagePath} (bad api: line)`); continue; }
    const method = apiMatch[1].toLowerCase();
    const urlPath = apiMatch[2].replace(/^https?:\/\/[^/]+/, '') || '/';

    if (group && !tagOrder.includes(group)) tagOrder.push(group);

    const fields = parseParamFields(body);
    const parameters = [];
    const bodySchema = { type: 'object', properties: {} };
    let hasBody = false;

    for (const f of fields) {
      if (f.location === 'body') { hasBody = true; insertBody(bodySchema, f); continue; }
      const types = mapTypes(f.type);
      const schema = { type: types.length === 1 ? types[0] : types };
      if (arrayTyped(schema.type)) schema.items = {};
      const def = coerceDefault(f.default, types[0]);
      if (def !== undefined) schema.default = def;
      parameters.push({
        name: f.name,
        in: f.location,
        required: f.location === 'path' ? true : f.required,
        ...(f.desc ? { description: f.desc } : {}),
        schema,
      });
    }

    // Ensure every {param} in the path is declared.
    for (const pm of urlPath.matchAll(/\{([^}]+)\}/g)) {
      const pname = pm[1];
      if (!parameters.some((p) => p.in === 'path' && p.name === pname)) {
        parameters.push({ name: pname, in: 'path', required: true, schema: { type: 'string' } });
      }
    }

    const operation = {
      operationId: operationId(pagePath),
      summary: fm.title || undefined,
      ...(fm.description ? { description: fm.description } : {}),
      ...(group ? { tags: [group] } : {}),
    };
    if (parameters.length) operation.parameters = parameters;

    // GET/HEAD request bodies have no well-defined semantics; skip them.
    const bodyAllowed = method !== 'get' && method !== 'head';
    if (bodyAllowed && hasBody && Object.keys(bodySchema.properties).length) {
      const example = extractRequestBodyExample(body);
      operation.requestBody = {
        required: Array.isArray(bodySchema.required) && bodySchema.required.length > 0,
        content: {
          'application/json': {
            schema: bodySchema,
            ...(example !== undefined ? { example } : {}),
          },
        },
      };
    }

    const responses = extractResponses(body);
    if (!Object.keys(responses).length) {
      responses['200'] = { description: 'OK' };
      stats.noResponses.push(pagePath);
    }
    operation.responses = responses;

    if (!paths[urlPath]) paths[urlPath] = {};
    paths[urlPath][method] = operation;
    stats.operations++;
    if (group && !tagsUsed.includes(group)) tagsUsed.push(group);
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: docs.name || 'API',
      version: '2.0',
      description: 'Programmatically manage your email marketing — lists, subscribers, campaigns, automations, and more.',
      contact: { name: 'Ecomail', url: 'https://ecomail.cz', email: 'support@ecomail.cz' },
      license: { name: 'Proprietary', url: 'https://ecomail.cz/obchodni-podminky/' },
    },
    servers: [{ url: server }],
    security: [{ apiKey: [] }],
    tags: tagOrder.filter((t) => tagsUsed.includes(t)).map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: authName },
      },
    },
  };

  return { spec, stats };
}

// ---------- CLI ----------

function main() {
  const rootArgIdx = process.argv.indexOf('--root');
  const root = rootArgIdx !== -1
    ? resolve(process.argv[rootArgIdx + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outArgIdx = process.argv.indexOf('--out');
  const out = outArgIdx !== -1 ? resolve(process.argv[outArgIdx + 1]) : join(root, 'openapi.json');

  const { spec, stats } = generateSpec(root);
  writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');

  const pathCount = Object.keys(spec.paths).length;
  console.log(`✓ Wrote ${out}`);
  console.log(`  ${stats.operations} operations across ${pathCount} paths, ${spec.tags.length} tags`);
  if (stats.skipped.length) console.log(`  skipped (non-endpoints): ${stats.skipped.length}`);
  if (stats.noResponses.length) {
    console.log(`  ⚠ no documented response, defaulted to 200: ${stats.noResponses.join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}