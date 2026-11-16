// 数字滚动：场数、胜率、等级分第一次显示时从 0 滚到实际值（纯展示，不改数据）。
// 用法：把起始帧并进渲染的那一次 setData（路径写在整块数据后面，会盖住对应字段）
//   this.setData(Object.assign({ me }, Anim.roll(this, { 'me.played': me.played, 'me.rate': me.rate })));
// 每个页面 / 组件实例只滚一次；滚动中又有新的渲染时（再次调用 roll）直接停下，显示新数据。
const MS = 600;   // 总时长
const STEP = 32;  // 每帧间隔（逻辑层没有 requestAnimationFrame）

const ease = (t) => 1 - Math.pow(1 - t, 3); // 先快后慢

// 把文字里的每个数字按进度 t（0～1）缩小，小数位数不变：'12胜 5负' → '6胜 3负'，'3.52' → '1.76'
function rollText(v, t) {
  return String(v).replace(/\d+(\.\d+)?/g, (m, dec) => {
    const n = parseFloat(m) * t;
    return dec ? n.toFixed(dec.length - 1) : String(Math.round(n));
  });
}

function frame(values, t) {
  const out = {};
  Object.keys(values).forEach((k) => { out[k] = t >= 1 ? values[k] : rollText(values[k], t); });
  return out;
}

function stop(ctx) {
  if (ctx._rollTimer) { clearTimeout(ctx._rollTimer); ctx._rollTimer = null; }
}

// values：{ 数据路径: 最终值 }。返回要并进同一次 setData 的起始帧；不需要滚动时返回 {}
function roll(ctx, values) {
  stop(ctx);
  if (ctx._rolled) return {};
  const keys = Object.keys(values || {}).filter((k) => /[1-9]/.test(String(values[k])));
  if (!keys.length) return {}; // 还没有数据（都是 0 或「暂无」）：等有数据的那次渲染再滚
  ctx._rolled = true;
  const target = {};
  keys.forEach((k) => { target[k] = values[k]; });
  const start = Date.now();
  const tick = () => {
    const t = Math.min(1, (Date.now() - start) / MS);
    ctx.setData(frame(target, ease(t)));
    ctx._rollTimer = t < 1 ? setTimeout(tick, STEP) : null;
  };
  ctx._rollTimer = setTimeout(tick, STEP);
  return frame(target, 0);
}

module.exports = { roll, stop, rollText, MS };
