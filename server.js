const http = require('http');

const PORT = process.env.PORT || 8080;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function queryDocker(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from Docker API: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getContainers() {
  const containers = await queryDocker('/v1.45/containers/json?all=true');
  if (!Array.isArray(containers)) {
    throw new Error(containers.message || 'Unexpected response from Docker API');
  }
  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`)
      .join(', '),
    created: c.Created,
  }));
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docker Status</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    background: #0d1117; color: #c9d1d9;
    padding: 1.5rem; min-height: 100vh;
  }
  header {
    display: flex; justify-content: space-between; align-items: baseline;
    flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem;
  }
  h1 { font-size: 1.25rem; font-weight: 600; color: #e6edf3; }
  .meta { font-size: 0.75rem; color: #8b949e; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;
    border-left: 3px solid #30363d;
  }
  .card.running  { border-left-color: #3fb950; }
  .card.exited   { border-left-color: #f85149; }
  .card.restarting, .card.created { border-left-color: #d29922; }
  .card-header { display: flex; justify-content: space-between; align-items: center; }
  .name { font-weight: 600; color: #e6edf3; font-size: 0.95rem; }
  .badge {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 12px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .badge.running    { background: #0f2d1a; color: #3fb950; }
  .badge.exited     { background: #2d1216; color: #f85149; }
  .badge.restarting { background: #2d2210; color: #d29922; }
  .badge.created    { background: #2d2210; color: #d29922; }
  .row { display: flex; gap: 0.5rem; font-size: 0.8rem; }
  .label { color: #8b949e; min-width: 50px; }
  .value { color: #c9d1d9; word-break: break-all; }
  .error {
    background: #2d1216; border: 1px solid #f8514966; border-radius: 8px;
    padding: 1rem; color: #f85149; text-align: center;
  }
  @media (max-width: 400px) {
    body { padding: 1rem; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <header>
    <h1>Docker Status</h1>
    <span class="meta" id="updated"></span>
  </header>
  <div id="content"><p class="meta">Loading&hellip;</p></div>
<script>
async function refresh() {
  try {
    const res = await fetch('/api/containers');
    if (!res.ok) throw new Error(res.statusText);
    const containers = await res.json();
    const grid = document.createElement('div');
    grid.className = 'grid';
    if (containers.length === 0) {
      grid.innerHTML = '<p class="meta">No containers found.</p>';
    }
    containers.forEach(c => {
      const state = c.state.toLowerCase();
      const card = document.createElement('div');
      card.className = 'card ' + state;
      card.innerHTML =
        '<div class="card-header">' +
          '<span class="name">' + esc(c.name) + '</span>' +
          '<span class="badge ' + state + '">' + esc(c.state) + '</span>' +
        '</div>' +
        '<div class="row"><span class="label">Image</span><span class="value">' + esc(c.image) + '</span></div>' +
        '<div class="row"><span class="label">Status</span><span class="value">' + esc(c.status) + '</span></div>' +
        (c.ports ? '<div class="row"><span class="label">Ports</span><span class="value">' + esc(c.ports) + '</span></div>' : '') +
        '<div class="row"><span class="label">ID</span><span class="value">' + esc(c.id) + '</span></div>';
      grid.appendChild(card);
    });
    document.getElementById('content').replaceChildren(grid);
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('content').innerHTML =
      '<div class="error">Failed to fetch container status: ' + esc(String(err)) + '</div>';
  }
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/containers') {
    try {
      const containers = await getContainers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(containers));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Docker status dashboard running on http://localhost:${PORT}`);
});
