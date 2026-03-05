const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PM2_HOME = process.env.PM2_HOME || '';
const DEPLOY_PROGRESS_FILE = process.env.DEPLOY_PROGRESS_FILE || '/tmp/deploy-progress.json';

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

function getPm2Processes() {
  if (!PM2_HOME) return null;
  try {
    const dumpPath = path.join(PM2_HOME, 'dump.pm2');
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const pidsDir = path.join(PM2_HOME, 'pids');

    return dump.map((proc) => {
      const name = proc.name;
      // Find matching PID file
      let pid = null;
      let online = false;
      try {
        const files = fs.readdirSync(pidsDir);
        const pidFile = files.find((f) => f.startsWith(name + '-'));
        if (pidFile) {
          pid = parseInt(fs.readFileSync(path.join(pidsDir, pidFile), 'utf8').trim(), 10);
          // Check if process is alive via /proc
          if (pid > 0) {
            fs.statSync(`/proc/${pid}`);
            online = true;
          }
        }
      } catch {
        online = false;
      }

      const uptime = proc.pm_uptime || proc.env?.pm_uptime;

      // Check if process has child processes (i.e. actively running a task)
      let active = false;
      if (online && pid) {
        try {
          const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
          active = children.length > 0;
        } catch {
          // /proc/.../children may not exist on all kernels; fall back to scanning
          try {
            const procs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
            for (const p of procs) {
              try {
                const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
                const ppid = parseInt(stat.split(') ')[1]?.split(' ')[1], 10);
                if (ppid === pid) { active = true; break; }
              } catch {}
            }
          } catch {}
        }
      }

      return {
        name,
        pid: online ? pid : null,
        state: online ? (active ? 'active' : 'online') : 'stopped',
        interpreter: proc.exec_interpreter || 'node',
        script: path.basename(proc.pm_exec_path || ''),
        uptime: online && uptime ? formatUptime(uptime) : null,
      };
    });
  } catch {
    return null;
  }
}

function getDeployProgress() {
  try {
    const raw = fs.readFileSync(DEPLOY_PROGRESS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.deploying !== 'boolean' || !Array.isArray(data.steps)) return null;
    return data;
  } catch {
    return null;
  }
}

function formatUptime(startMs) {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
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
  .section-label {
    font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: #8b949e; margin: 1.5rem 0 0.75rem;
  }
  .section-label:first-of-type { margin-top: 0; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;
    border-left: 3px solid #30363d;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .card.running, .card.online { border-left-color: #3fb950; }
  .card.exited, .card.stopped  { border-left-color: #f85149; }
  .card.restarting, .card.created { border-left-color: #d29922; }
  .card.active { border-left-color: #1f6feb; grid-column: 1 / -1; }
  .card-header { display: flex; justify-content: space-between; align-items: center; }
  .name { font-weight: 600; color: #e6edf3; font-size: 0.95rem; }
  .badge {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 12px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .badge.running, .badge.online { background: #0f2d1a; color: #3fb950; }
  .badge.exited, .badge.stopped { background: #2d1216; color: #f85149; }
  .badge.restarting { background: #2d2210; color: #d29922; }
  .badge.active { background: #0d1d3a; color: #1f6feb; }
  .badge.created    { background: #2d2210; color: #d29922; }
  .row { display: flex; gap: 0.5rem; font-size: 0.8rem; }
  .label { color: #8b949e; min-width: 50px; }
  .value { color: #c9d1d9; word-break: break-all; }
  .error {
    background: #2d1216; border: 1px solid #f8514966; border-radius: 8px;
    padding: 1rem; color: #f85149; text-align: center;
  }
  .deploy-header {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 0.5rem; border-top: 1px solid #30363d;
    font-size: 0.75rem; font-weight: 600; color: #8b949e;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .deploy-header .elapsed { font-weight: 400; font-size: 0.7rem; color: #58a6ff; text-transform: none; letter-spacing: 0; }
  .deploy-steps {
    display: flex; flex-direction: column; gap: 0.35rem;
  }
  .deploy-step {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.8rem; color: #c9d1d9;
  }
  .deploy-step.pending { opacity: 0.35; }
  .deploy-step.running { opacity: 1; }
  .deploy-step.done { color: #3fb950; opacity: 0.7; }
  .deploy-step.failed { color: #f85149; opacity: 1; }
  .step-icon {
    width: 16px; height: 16px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; font-size: 10px; line-height: 1;
  }
  .step-icon.pending { border: 1.5px solid #484f58; }
  .step-icon.running {
    border: 2px solid transparent;
    border-top-color: #58a6ff; border-right-color: #58a6ff;
    animation: spin 0.8s linear infinite;
  }
  .step-icon.done { border: none; color: #3fb950; font-size: 12px; }
  .step-icon.failed { border: none; color: #f85149; font-size: 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-label { flex: 1; }
  .step-duration { font-size: 0.7rem; color: #8b949e; font-family: inherit; }
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
    const res = await fetch('api/status');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const content = document.getElementById('content');
    content.innerHTML = '';

    // Docker containers
    var label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Docker Containers';
    content.appendChild(label);

    var grid = document.createElement('div');
    grid.className = 'grid';
    if (data.containers.length === 0) {
      grid.innerHTML = '<p class="meta">No containers found.</p>';
    }
    data.containers.forEach(function(c) {
      var state = c.state.toLowerCase();
      var card = document.createElement('div');
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
    content.appendChild(grid);

    // PM2 processes
    if (data.pm2) {
      var pm2Label = document.createElement('div');
      pm2Label.className = 'section-label';
      pm2Label.textContent = 'PM2 Processes';
      content.appendChild(pm2Label);

      var pm2Grid = document.createElement('div');
      pm2Grid.className = 'grid';
      if (data.pm2.length === 0) {
        pm2Grid.innerHTML = '<p class="meta">No PM2 processes found.</p>';
      }
      data.pm2.forEach(function(p) {
        var dp = p.deployProgress;
        var showDeploy = dp && (dp.deploying || (dp.finishedAt && Date.now() - dp.finishedAt < 15000));
        var state = (showDeploy && p.state === 'active') ? 'active' : p.state.toLowerCase();
        var badgeText = (showDeploy && state === 'active') ? 'deploying' : p.state;
        var card = document.createElement('div');
        card.className = 'card ' + state;
        var html =
          '<div class="card-header">' +
            '<span class="name">' + esc(p.name) + '</span>' +
            '<span class="badge ' + state + '">' + esc(badgeText) + '</span>' +
          '</div>' +
          '<div class="row"><span class="label">Script</span><span class="value">' + esc(p.script) + '</span></div>' +
          (p.pid ? '<div class="row"><span class="label">PID</span><span class="value">' + esc(String(p.pid)) + '</span></div>' : '') +
          (p.uptime ? '<div class="row"><span class="label">Uptime</span><span class="value">' + esc(p.uptime) + '</span></div>' : '');
        if (showDeploy) {
          var elapsed = dp.startedAt ? fmtElapsed(dp.startedAt) : '';
          html += '<div class="deploy-header"><span>Deploy Progress</span><span class="elapsed">' + esc(elapsed) + '</span></div>';
          html += '<div class="deploy-steps">';
          dp.steps.forEach(function(s) {
            var icon = '';
            if (s.status === 'done') icon = '\\u2713';
            else if (s.status === 'failed') icon = '\\u2717';
            else if (s.status === 'running') icon = '';
            else icon = '';
            var dur = '';
            if (s.status === 'done' && s.startedAt && s.doneAt) dur = fmtMs(s.doneAt - s.startedAt);
            else if (s.status === 'running' && s.startedAt) dur = fmtElapsed(s.startedAt);
            html += '<div class="deploy-step ' + esc(s.status) + '">' +
              '<span class="step-icon ' + esc(s.status) + '">' + icon + '</span>' +
              '<span class="step-label">' + esc(s.label) + '</span>' +
              (dur ? '<span class="step-duration">' + esc(dur) + '</span>' : '') +
              '</div>';
          });
          html += '</div>';
        }
        card.innerHTML = html;
        pm2Grid.appendChild(card);
      });
      content.appendChild(pm2Grid);
    }

    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('content').innerHTML =
      '<div class="error">Failed to fetch status: ' + esc(String(err)) + '</div>';
  }
}
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}
function fmtElapsed(startMs) {
  var sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  return min + 'm ' + (sec % 60) + 's';
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

  if (req.method === 'GET' && req.url === '/api/status') {
    const result = { containers: [], pm2: null };
    try {
      result.containers = await getContainers();
    } catch (err) {
      result.containers = [];
      result.dockerError = err.message;
    }
    result.pm2 = getPm2Processes();
    if (result.pm2) {
      const progress = getDeployProgress();
      if (progress) {
        const webhook = result.pm2.find((p) => p.name === 'deploy-webhook');
        if (webhook) webhook.deployProgress = progress;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Keep old endpoint for backwards compat
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
