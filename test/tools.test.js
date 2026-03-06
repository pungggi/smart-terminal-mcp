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

test('tool schemas keep agent-friendly default output sizes', () => {
  const server = createFakeServer();

  registerTools(server, {});

  assert.deepEqual({
    terminalExecMaxLines: server.tools.get('terminal_exec').schema.maxLines.parse(undefined),
    terminalReadMaxLines: server.tools.get('terminal_read').schema.maxLines.parse(undefined),
    terminalHistoryMaxLines: server.tools.get('terminal_get_history').schema.maxLines.parse(undefined),
    terminalRunPagedPageSize: server.tools.get('terminal_run_paged').schema.pageSize.parse(undefined),
  }, {
    terminalExecMaxLines: 200,
    terminalReadMaxLines: 200,
    terminalHistoryMaxLines: 200,
    terminalRunPagedPageSize: 100,
  });
});

test('terminal_wait forwards returnMode and tailLines', async () => {
  const server = createFakeServer();
  const waitCalls = [];
  const manager = {
    get: () => ({
      waitForPattern: async (opts) => {
        waitCalls.push(opts);
        return { output: 'ready', matched: true, timedOut: false };
      },
    }),
  };
  const sendNotification = () => { };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_wait').handler(
    {
      sessionId: 's1',
      pattern: 'ready',
      timeout: 1234,
      returnMode: 'full',
      tailLines: 99,
    },
    {
      sendNotification,
      _meta: { progressToken: 'progress-1' },
    }
  );

  assert.deepEqual(waitCalls, [{
    pattern: 'ready',
    timeout: 1234,
    returnMode: 'full',
    tailLines: 99,
    sendNotification,
    progressToken: 'progress-1',
  }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    output: 'ready',
    matched: true,
    timedOut: false,
  });
});