// 数字滚动：场数、胜率、等级分第一次显示时从 0 滚到实际值（纯展示，不改数据）。
// 用法：把起始帧并进渲染的那一次 setData（路径写在整块数据后面，会盖住对应字段）
//   this.setData(Object.assign({ me }, Anim.roll(this, { 'me.played': me.played, 'me.rate': me.rate })));
// 每个页面 / 组件实例只滚一次；滚动中又有新的渲染时（再次调用 roll）直接停下，显示新数据。
// tab 页切走再回来（页面实例不会重建）想再播一次：onHide 调 leave，onShow 把 enter 的返回值并进 setData；
// 页面上的入场动画类写成 {{play ? 'ani-in' : 'ani-wait'}}（进度条 ani-grow-x / ani-wait-x），data 里 play 默认 true。
const MS = 750;   // 总时长
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
function pickNums(values) {
  const target = {};
  Object.keys(values || {}).forEach((k) => { if (/[1-9]/.test(String(values[k]))) target[k] = values[k]; });
  return target;
}

function roll(ctx, values) {
  stop(ctx);
  ctx._rollValues = values || {};
  if (ctx._replay) return frame(pickNums(values), 0); // 切走期间又渲染了：先停在 0，回来时再滚
  if (ctx._rolled) return {};
  const target = pickNums(values);
  if (!Object.keys(target).length) return {}; // 还没有数据（都是 0 或「暂无」）：等有数据的那次渲染再滚
  ctx._rolled = true;
  const start = Date.now();
  const tick = () => {
    const t = Math.min(1, (Date.now() - start) / MS);
    ctx.setData(frame(target, ease(t)));
    ctx._rollTimer = t < 1 ? setTimeout(tick, STEP) : null;
  };
  ctx._rollTimer = setTimeout(tick, STEP);
  return frame(target, 0);
}

// 是不是只被新打开的子页面盖住（点进详情）：这种情况返回时保持原样，不重播
function covered(ctx) {
  try {
    const ps = getCurrentPages();
    return ps.indexOf(ctx) >= 0 && ps[ps.length - 1] !== ctx;
  } catch (e) { return false; }
}

// onHide：切换 tab、退到后台时把页面恢复成「入场前」（动画类换成等待态、数字归 0），回来时再播
function leave(ctx) {
  if (covered(ctx)) return;
  stop(ctx);
  ctx._replay = true;
  ctx.setData(Object.assign({ play: false }, frame(pickNums(ctx._rollValues), 0)));
}

// onShow：返回要并进 setData 的数据（重新加上动画类 + 数字从 0 滚到当前值）；不需要重播时返回 {}
function enter(ctx) {
  if (!ctx._replay) return {};
  ctx._replay = false;
  ctx._rolled = false;
  return Object.assign({ play: true }, roll(ctx, ctx._rollValues));
}

module.exports = { roll, stop, leave, enter, rollText, MS };
