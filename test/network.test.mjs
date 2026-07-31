import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { __testing } = await import('../src/tools.mjs');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('公网 URL 校验拒绝内网和本地协议', async () => {
  assert.equal((await __testing.vetPublicUrl('http://127.0.0.1/x')).ok, false);
  assert.equal((await __testing.vetPublicUrl('http://169.254.169.254/latest')).ok, false);
  assert.equal((await __testing.vetPublicUrl('file:///etc/passwd')).ok, false);
});

test('公网 URL 校验拒绝 IPv4-mapped IPv6 本地地址', async () => {
  assert.equal((await __testing.vetPublicUrl('http://[::ffff:127.0.0.1]/x')).ok, false);
  assert.equal((await __testing.vetPublicUrl('http://[::ffff:7f00:1]/x')).ok, false);
});

test('每一跳重定向都会重新进行 SSRF 校验', async () => {
  const server = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
    res.end();
  });
  try {
    const { port } = server.address();
    const result = await __testing.safeHttpGet(`http://127.0.0.1:${port}/`, {
      allowHost: '127.0.0.1',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /内网|本地/);
  } finally {
    server.close();
  }
});

test('响应体上限在读取前生效', async () => {
  const server = await startServer((_req, res) => {
    res.setHeader('content-length', '2000000');
    res.end('x');
  });
  try {
    const { port } = server.address();
    const result = await __testing.safeHttpGet(`http://127.0.0.1:${port}/`, {
      allowHost: '127.0.0.1',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /响应过大/);
  } finally {
    server.close();
  }
});
