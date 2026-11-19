/* Background jobs: generate a range of levels, or measure levels. One job per message. */
import { setRules, makeLevel } from './generator.js';
import { measure, validate } from './metrics.js';

self.onmessage = (e) => {
  const job = e.data;
  try {
    if (job.type === 'generate') {
      const rules = setRules(job.config);
      const seen = new Set();
      const levels = [];
      const stats = [];
      for (let i = job.from; i <= job.to; i++) {
        const L = makeLevel(job.config, rules, job.set, i, seen);
        levels.push(L);
        stats.push(measure(L, i - 1));
        if ((i - job.from) % 5 === 4) self.postMessage({ id: job.id, progress: i - job.from + 1 });
      }
      self.postMessage({ id: job.id, done: true, levels, stats });
    } else if (job.type === 'measure') {
      const stats = [];
      const errors = [];
      job.levels.forEach((L, k) => {
        const errs = validate(L);
        if (errs.length) errors.push({ id: L.id, errs });
        stats.push(errs.length && errs.some((x) => !x.startsWith('ходів')) ? null : measure(L, job.offset + k));
        if (k % 20 === 19) self.postMessage({ id: job.id, progress: k + 1 });
      });
      self.postMessage({ id: job.id, done: true, stats, errors });
    }
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err && err.message || err) });
  }
};
