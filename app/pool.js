/* A small pool of module workers. Splits a job list over them and reports progress. */
const SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
let workers = [];
let seq = 0;

function spawn() {
  if (workers.length) return;
  workers = Array.from({ length: SIZE }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
}
export function cancel() {
  workers.forEach((w) => w.terminate());
  workers = [];
}

/* jobs: [{type, ...}] each with a `weight` (units of progress). Resolves with results in job order. */
export function run(jobs, onProgress = () => {}) {
  spawn();
  const total = jobs.reduce((s, j) => s + (j.weight || 1), 0);
  const prog = new Map();
  const results = new Array(jobs.length);
  let next = 0;
  let finished = 0;
  return new Promise((resolve, reject) => {
    if (!jobs.length) return resolve([]);
    const feed = (w) => {
      if (next >= jobs.length) return;
      const k = next++;
      const id = ++seq;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.error) { cancel(); return reject(new Error(m.error)); }
        if (m.progress != null) prog.set(k, m.progress);
        if (m.done) {
          results[k] = m;
          prog.set(k, jobs[k].weight || 1);
          finished++;
          if (finished === jobs.length) return resolve(results);
          feed(w);
        }
        onProgress([...prog.values()].reduce((s, v) => s + v, 0) / total);
      };
      w.onerror = (e) => { cancel(); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ ...jobs[k], id });
    };
    workers.forEach(feed);
  });
}

/* Generate positions from..to of a set, in chunks of 25. */
export async function generate(config, set, from, to, onProgress) {
  const jobs = [];
  for (let a = from; a <= to; a += 25) {
    const b = Math.min(to, a + 24);
    jobs.push({ type: 'generate', config, set, from: a, to: b, weight: b - a + 1 });
  }
  const res = await run(jobs, onProgress);
  return { levels: res.flatMap((r) => r.levels), stats: res.flatMap((r) => r.stats) };
}

/* Validate and measure levels (positions start at offset). */
export async function measureAll(levels, onProgress) {
  const jobs = [];
  for (let a = 0; a < levels.length; a += 100) jobs.push({ type: 'measure', levels: levels.slice(a, a + 100), offset: a, weight: Math.min(100, levels.length - a) });
  const res = await run(jobs, onProgress);
  return { stats: res.flatMap((r) => r.stats), errors: res.flatMap((r) => r.errors) };
}
