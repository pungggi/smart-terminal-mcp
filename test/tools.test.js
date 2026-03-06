import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerTools } from '../src/tools.js';

function createFakeServer() {
  const tools = new Map();
  return {
    tools,
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  };
}

function getDescription(schema) {
  return schema.description ?? schema?._def?.description ?? '';
}

test('terminal_list returns compact JSON content', async () => {
  const server = createFakeServer();
  const sessions = [{ id: 's1', cwd: 'C:/repo' }];
  const manager = { list: () => sessions };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_list').handler({});
  const expected = { sessions, count: sessions.length };

  assert.equal(result.content[0].text, JSON.stringify(expected));
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});

test('tools source does not pretty-print JSON responses', async () => {
  const source = await readFile(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /JSON\.stringify\([^\n]*null,\s*2/);
});

test('tool metadata stays concise', () => {
  const server = createFakeServer();

  registerTools(server, {});

  for (const [name, { description, schema }] of server.tools) {
    assert.ok(description.length <= 70, `${name} description is too long`);
    assert.doesNotMatch(description, /Supported keys:/);

    for (const [fieldName, fieldSchema] of Object.entries(schema)) {
      const fieldDescription = getDescription(fieldSchema);
      assert.ok(fieldDescription.length <= 30, `${name}.${fieldName} description is too long`);
      assert.doesNotMatch(fieldDescription, /\(default:|e\.g\.|Defaults to|such as/i);
    }
  }
});