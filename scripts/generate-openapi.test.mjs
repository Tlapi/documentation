// Tests for generate-openapi.mjs.
//
// Strategy: a small fixture docs set lives under __fixtures__/. Each "edit" test
// copies the fixtures to a temp dir, mutates one MDX (or docs.json), regenerates,
// and asserts the EXACT set of leaf changes vs the baseline spec — so a change in
// the MDX must produce precisely the expected change in the OpenAPI output, nothing more.
//
// Run: node --test scripts/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { generateSpec } from './generate-openapi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__');

const { spec } = generateSpec(FIXTURES);

// ---------- diff helpers ----------

// Flatten a value into { "a.b[0].c": leaf } entries. Empty containers get a sentinel.
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') { out[prefix] = value; return out; }
  if (Array.isArray(value)) {
    if (value.length === 0) { out[prefix] = '[]'; return out; }
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) { out[prefix] = '{}'; return out; }
  for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// Sorted, human-readable list of leaf-level differences between two objects.
function diffLeaves(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const changes = [];
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (!(k in fa)) changes.push(`+ ${k} = ${JSON.stringify(fb[k])}`);
    else if (!(k in fb)) changes.push(`- ${k} = ${JSON.stringify(fa[k])}`);
    else if (fa[k] !== fb[k]) changes.push(`~ ${k}: ${JSON.stringify(fa[k])} -> ${JSON.stringify(fb[k])}`);
  }
  return changes.sort();
}

// Copy fixtures to a temp dir, apply `mutate(root)`, regenerate, return the spec.
function regenerate(mutate) {
  const tmp = mkdtempSync(join(tmpdir(), 'openapi-fix-'));
  try {
    cpSync(FIXTURES, tmp, { recursive: true });
    mutate(tmp);
    return generateSpec(tmp).spec;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function editFile(root, rel, transform) {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const after = transform(before);
  assert.notEqual(after, before, `no-op edit on ${rel} — the target string was not found`);
  writeFileSync(p, after);
}

const CREATE = 'api-reference/widgets/create.mdx';
const BODY = 'paths./widgets.post.requestBody.content.application/json';

// ---------- baseline correctness ----------

test('spec scaffolding comes from docs.json', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'Fixture API');
  assert.deepEqual(spec.servers, [{ url: 'https://api.example.test' }]);
  assert.deepEqual(spec.components.securitySchemes.apiKey, { type: 'apiKey', in: 'header', name: 'key' });
  assert.deepEqual(spec.tags, [{ name: 'Widgets' }]);
});

test('a page without api: frontmatter is skipped', () => {
  const ops = Object.values(spec.paths).reduce((n, m) => n + Object.keys(m).length, 0);
  assert.equal(ops, 4); // GET+POST /widgets, GET+PUT /widgets/{id}
  assert.ok(!JSON.stringify(spec).includes('widgetsIntro'));
});

test('GET /widgets — query params and array response schema', () => {
  const op = spec.paths['/widgets'].get;
  assert.equal(op.operationId, 'widgetsList');
  assert.equal(op.summary, 'List widgets');
  assert.deepEqual(op.parameters.find((p) => p.name === 'page'), {
    name: 'page', in: 'query', required: false, description: 'Page number.',
    schema: { type: 'integer', default: 1 },
  });
  assert.equal(op.parameters.find((p) => p.name === 'active').schema.type, 'boolean');
  const sch = op.responses['200'].content['application/json'].schema;
  assert.equal(sch.type, 'array');
  assert.deepEqual(sch.items.properties.id, { type: 'integer' });
  assert.deepEqual(sch.items.properties.active, { type: 'boolean' });
});

test('GET /widgets/{id} — path param is required, 404 captured', () => {
  const op = spec.paths['/widgets/{id}'].get;
  const id = op.parameters.find((p) => p.name === 'id');
  assert.equal(id.in, 'path');
  assert.equal(id.required, true);
  assert.equal(id.schema.type, 'integer');
  assert.equal(op.responses['404'].description, 'Not Found');
});

test('POST /widgets — nested body schema, required, defaults, example', () => {
  const op = spec.paths['/widgets'].post;
  assert.equal(op.requestBody.required, true);
  const schema = op.requestBody.content['application/json'].schema;

  assert.deepEqual(schema.required, ['name', 'parts']);
  assert.equal(schema.properties.name.type, 'string');
  assert.equal(schema.properties.active.type, 'boolean');
  assert.equal(schema.properties.active.default, true); // coerced from "true"

  // dot notation -> nested object
  assert.equal(schema.properties.meta.type, 'object');
  assert.equal(schema.properties.meta.properties.color.type, 'string');

  // bracket notation -> array of objects with nested required + default
  const parts = schema.properties.parts;
  assert.equal(parts.type, 'array');
  assert.equal(parts.items.type, 'object');
  assert.deepEqual(parts.items.required, ['sku']);
  assert.equal(parts.items.properties.qty.type, 'integer');
  assert.equal(parts.items.properties.qty.default, 1);

  // array of scalars
  assert.equal(schema.properties.tags.type, 'array');
  assert.deepEqual(schema.properties.tags.items, {});

  // example pulled from the cURL -d block
  assert.deepEqual(op.requestBody.content['application/json'].example, {
    name: 'Widget A', active: true, parts: [{ sku: 'AAA', qty: 2 }],
  });
});

test('a GET never emits a requestBody (body ParamFields are dropped)', () => {
  const op = spec.paths['/widgets'].get;
  assert.equal(op.requestBody, undefined);
  // query params are unaffected
  assert.ok(op.parameters.some((p) => p.name === 'page'));
});

test('info carries contact and license', () => {
  assert.equal(spec.info.contact.email, 'support@ecomail.cz');
  assert.ok(spec.info.license.name);
});

test('union type that includes "array" still gets an items schema', () => {
  // Regression: ["array","object"] must carry `items` to satisfy OpenAPI 3.1 / JSON Schema.
  const labels = spec.paths['/widgets'].post
    .requestBody.content['application/json'].schema.properties.labels;
  assert.deepEqual(labels.type, ['array', 'object']);
  assert.deepEqual(labels.items, {});
});

test('generation is deterministic', () => {
  assert.deepEqual(generateSpec(FIXTURES).spec, generateSpec(FIXTURES).spec);
});

// ---------- edit MDX -> regenerate -> exact diff ----------

test('edit: change a body field type → only that type changes', () => {
  const after = regenerate((root) => editFile(root, CREATE, (s) =>
    s.replace('<ParamField body="name" type="string" required>',
      '<ParamField body="name" type="integer" required>')));
  assert.deepEqual(diffLeaves(spec, after), [
    `~ ${BODY}.schema.properties.name.type: "string" -> "integer"`,
  ]);
});

test('edit: change a default → only the (coerced) default changes', () => {
  const after = regenerate((root) => editFile(root, CREATE, (s) =>
    s.replace('<ParamField body="active" type="boolean" default="true">',
      '<ParamField body="active" type="boolean" default="false">')));
  assert.deepEqual(diffLeaves(spec, after), [
    `~ ${BODY}.schema.properties.active.default: true -> false`,
  ]);
});

test('edit: mark an optional field required → required array updates exactly', () => {
  const after = regenerate((root) => editFile(root, CREATE, (s) =>
    s.replace('<ParamField body="tags" type="array">',
      '<ParamField body="tags" type="array" required>')));
  // baseline ["name","parts"] -> ["name","tags","parts"]
  assert.deepEqual(diffLeaves(spec, after), [
    `+ ${BODY}.schema.required[2] = "parts"`,
    `~ ${BODY}.schema.required[1]: "parts" -> "tags"`,
  ]);
});

test('edit: change the cURL -d example → only the example value changes', () => {
  const after = regenerate((root) => editFile(root, CREATE, (s) =>
    s.replace('"name": "Widget A",', '"name": "Widget Z",')));
  assert.deepEqual(diffLeaves(spec, after), [
    `~ ${BODY}.example.name: "Widget A" -> "Widget Z"`,
  ]);
});

test('edit: add an endpoint + register it in docs.json → one new operation, nothing else moves', () => {
  const after = regenerate((root) => {
    writeFileSync(join(root, 'api-reference/widgets/delete.mdx'),
      [
        '---',
        "title: 'Delete widget'",
        "api: 'DELETE https://api.example.test/widgets/{id}'",
        "description: 'Delete a widget.'",
        '---',
        '',
        '<ParamField path="id" type="integer" required>',
        '  Widget ID.',
        '</ParamField>',
        '',
        '<ResponseExample>',
        '```json 204',
        '{}',
        '```',
        '</ResponseExample>',
        '',
      ].join('\n'));
    const docs = JSON.parse(readFileSync(join(root, 'docs.json'), 'utf8'));
    docs.navigation.tabs[0].groups[0].pages.push('api-reference/widgets/delete');
    writeFileSync(join(root, 'docs.json'), JSON.stringify(docs, null, 2));
  });

  assert.equal(after.paths['/widgets/{id}'].delete.operationId, 'widgetsDelete');
  const changes = diffLeaves(spec, after);
  const stray = changes.filter((c) => !c.startsWith('+ paths./widgets/{id}.delete'));
  assert.deepEqual(stray, [], 'changes leaked outside the new operation:\n' + stray.join('\n'));
});

test('edit: renaming a path param forks the path (documents the collision pitfall)', () => {
  const after = regenerate((root) => editFile(root, 'api-reference/widgets/get.mdx', (s) =>
    s.replace("api: 'GET https://api.example.test/widgets/{id}'",
      "api: 'GET https://api.example.test/widgets/{widget_id}'")
      .replace('<ParamField path="id" type="integer" required>',
        '<ParamField path="widget_id" type="integer" required>')));
  assert.ok(after.paths['/widgets/{widget_id}'].get, 'GET should move to the new key');
  assert.ok(after.paths['/widgets/{id}'].put, 'PUT should stay on the old key');
  assert.ok(!after.paths['/widgets/{id}'].get, 'old key should no longer carry GET');
});
