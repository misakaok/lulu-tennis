// 测试用的假计时器：时间是虚拟的，不用真的等。
// 每当没有别的事可做（Promise 链都跑完了），就把虚拟时间拨到最早的那个计时器并执行它，先后顺序和真实时间一样，
// 所以「等页面出现」「检测超时」「动画放完」这类测试照常按时间顺序走，只是一瞬间跑完。
//   const clock = require('./fake-clock')();
//   传给被测代码：vm 上下文里放 clock.setTimeout / clock.clearTimeout / clock.Date；
//   直接 require 的模块用全局计时器：await clock.run(async () => { ... })，跑完恢复真实的 setTimeout / Date。
//   等一段虚拟时间：await clock.wait(ms)
module.exports = function fakeClock(start) {
  const base = typeof start === 'number' ? start : Date.now();
  const RealDate = Date, realImmediate = setImmediate;
  const q = new Map();
  let now = 0, seq = 0, pending = false;
  const pump = () => { if (!pending && q.size) { pending = true; realImmediate(step); } };
  function step() {
    pending = false;
    let next = null;
    for (const x of q.values()) if (!next || x.t < next.t || (x.t === next.t && x.id < next.id)) next = x;
    if (!next) return;
    q.delete(next.id);
    now = Math.max(now, next.t);
    try { next.f(...next.a); } finally { pump(); }
  }
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(base + now); }
    static now() { return base + now; }
  }
  const clock = {
    Date: FakeDate,
    now: () => base + now,
    setTimeout(f, ms, ...a) { const id = ++seq; q.set(id, { id, t: now + Math.max(0, Number(ms) || 0), f, a }); pump(); return id; },
    clearTimeout(id) { q.delete(id); },
    wait: (ms) => new Promise((r) => clock.setTimeout(r, ms)),
    async run(fn) {
      const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, Date: global.Date };
      Object.assign(global, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: FakeDate });
      try { return await fn(); } finally { Object.assign(global, saved); }
    },
  };
  return clock;
};
