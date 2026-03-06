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
      let pid = null;
      let online = false;
      try {
        const files = fs.readdirSync(pidsDir);
        const pidFile = files.find((f) => f.startsWith(name + '-'));
        if (pidFile) {
          pid = parseInt(fs.readFileSync(path.join(pidsDir, pidFile), 'utf8').trim(), 10);
          if (pid > 0) {
            fs.statSync(`/proc/${pid}`);
            online = true;
          }
        }
      } catch {
        online = false;
      }

      const uptime = proc.pm_uptime || proc.env?.pm_uptime;

      let active = false;
      if (online && pid) {
        try {
          const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
          active = children.length > 0;
        } catch {
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

const HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

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
